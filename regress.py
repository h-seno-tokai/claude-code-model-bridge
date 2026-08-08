#!/usr/bin/env python3
"""bridge の SSE 変換に対する回帰テスト.

モック上流を chunked で応答させ, 病的なチャンク分割・途中切断を再現する.
実 API には一切アクセスしないため, API キー不要・課金なしで実行できる.
"""
import json, os, socket, socketserver, subprocess, sys, threading, time, urllib.request, urllib.error

MOCK_PORT, PROXY_PORT = 9991, 8791
PROXY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy.mjs")


def sse(obj):
    return f"data: {json.dumps(obj)}\n\n".encode()


def chunk(b):
    return f"{len(b):x}\r\n".encode() + b + b"\r\n"


def delta(d, finish=None):
    return {"choices": [{"index": 0, "delta": d, "finish_reason": finish}]}


SCENARIOS = {
    # 引数が name/id より先に届く
    "S6_ARGS_FIRST": ([
        delta({"tool_calls": [{"index": 0, "function": {"arguments": '{"a":'}}]}),
        delta({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                               "function": {"name": "Read", "arguments": '1}'}}]}),
        delta({}, finish="tool_calls"),
    ], False),
    # tool 名が分割して届く
    "S4_NAME_SPLIT": ([
        delta({"tool_calls": [{"index": 0, "id": "call_2", "function": {"name": "get_"}}]}),
        delta({"tool_calls": [{"index": 0, "function": {"name": "weather", "arguments": '{"city":"tokyo"}'}}]}),
        delta({}, finish="tool_calls"),
    ], False),
    # finish_reason が来ないまま終了
    "S7_NO_FINISH": ([delta({"content": "partial answer"})], False),
    # ヘッダ送出後に切断
    "S8_ABORT": ([delta({"content": "hi"})], True),
    # 正常系 (回帰確認)
    "OK_TEXT": ([delta({"content": "hello"}), delta({}, finish="stop")], False),
    "OK_TOOL": ([
        delta({"reasoning_content": "thinking..."}),
        delta({"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "Read", "arguments": '{"file_path":"/x"}'}}]}),
        delta({}, finish="tool_calls"),
    ], False),
    # index が 0 始まりでない並列 tool
    "OK_MULTI": ([
        delta({"tool_calls": [{"index": 3, "id": "c3", "function": {"name": "Read", "arguments": '{"file_path":"/a"}'}}]}),
        delta({"tool_calls": [{"index": 5, "id": "c5", "function": {"name": "Grep", "arguments": '{"q":"z"}'}}]}),
        delta({}, finish="tool_calls"),
    ], False),
}


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        data = b""
        while b"\r\n\r\n" not in data:
            r = self.request.recv(65536)
            if not r:
                return
            data += r
        head, _, rest = data.partition(b"\r\n\r\n")
        clen = 0
        for line in head.decode(errors="ignore").split("\r\n"):
            if line.lower().startswith("content-length:"):
                clen = int(line.split(":")[1])
        while len(rest) < clen:
            rest += self.request.recv(65536)
        body = json.loads(rest.decode())
        chunks, abort = SCENARIOS[body["messages"][-1]["content"]]

        self.request.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
            b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
        for c in chunks:
            self.request.sendall(chunk(sse(c)))
            time.sleep(0.01)
        if abort:
            # 終端チャンクを送らずに切断する = クライアント側で terminated
            self.request.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                    b"\x01\x00\x00\x00\x00\x00\x00\x00")
            self.request.close()
            return
        self.request.sendall(chunk(sse({"usage": {"prompt_tokens": 10, "completion_tokens": 5}})))
        self.request.sendall(b"0\r\n\r\n")


def parse_sse(text):
    """(event, data) の列にする. event 行を伴わない生 JSON は ('RAW', line) で返す."""
    out, pending = [], None
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("event: "):
            pending = line[7:]
        elif line.startswith("data: "):
            out.append((pending or "NO_EVENT", line[6:]))
            pending = None
        elif line.strip():
            out.append(("RAW", line))
    return out


def call(scenario):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PROXY_PORT}/v1/messages",
        headers={"Content-Type": "application/json"},
        data=json.dumps({"model": "deepseek-test", "max_tokens": 100, "stream": True,
                         "messages": [{"role": "user", "content": scenario}]}).encode())
    try:
        return urllib.request.urlopen(req, timeout=30).read().decode()
    except urllib.error.HTTPError as e:
        return e.read().decode()


def main():
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", MOCK_PORT), Handler)
    srv.allow_reuse_address = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    env = dict(os.environ,
               BRIDGE_PORT=str(PROXY_PORT),
               DEEPSEEK_BASE_URL=f"http://127.0.0.1:{MOCK_PORT}/chat/completions",
               DEEPSEEK_API_KEY="dummy-key-for-mock",
               BRIDGE_LOG=os.path.join(os.path.dirname(PROXY), "regress.log"))
    proc = subprocess.Popen(["node", PROXY], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PROXY_PORT}/__bridge/health", timeout=1)
            break
        except Exception:
            time.sleep(0.2)

    fails = []

    def check(name, cond, detail=""):
        print(f"  {'OK  ' if cond else 'FAIL'} {name}" + (f"   {detail}" if not cond and detail else ""))
        if not cond:
            fails.append(name)

    try:
        print("[S6] 引数が name より先に届いても失われない")
        ev = parse_sse(call("S6_ARGS_FIRST"))
        merged = "".join(json.loads(d)["delta"]["partial_json"] for e, d in ev
                         if e == "content_block_delta" and '"input_json_delta"' in d)
        check("S6 引数が完全", merged and json.loads(merged) == {"a": 1}, f"got={merged!r}")

        print("[S4] tool 名が分割されても完全な名前になる")
        ev = parse_sse(call("S4_NAME_SPLIT"))
        names = [json.loads(d)["content_block"].get("name") for e, d in ev
                 if e == "content_block_start" and '"tool_use"' in d]
        check("S4 名前が完全", names == ["get_weather"], f"got={names}")

        print("[S7] finish_reason 無しの終了を完走と誤認しない")
        kinds = [e for e, _ in parse_sse(call("S7_NO_FINISH"))]
        check("S7 error を出す", "error" in kinds, f"got={kinds}")
        check("S7 message_stop を出さない", "message_stop" not in kinds, f"got={kinds}")

        print("[S8] 途中切断で SSE 本文に生 JSON を注入しない")
        kinds = [e for e, _ in parse_sse(call("S8_ABORT"))]
        check("S8 生 JSON なし", "RAW" not in kinds and "NO_EVENT" not in kinds, f"got={kinds}")
        check("S8 error を出す", "error" in kinds, f"got={kinds}")
        check("S8 message_stop を出さない", "message_stop" not in kinds, f"got={kinds}")

        print("[回帰] 正常系が壊れていない")
        ev = parse_sse(call("OK_TEXT"))
        kinds = [e for e, _ in ev]
        texts = "".join(json.loads(d)["delta"]["text"] for e, d in ev
                        if e == "content_block_delta" and '"text_delta"' in d)
        check("正常テキスト", texts == "hello" and "message_stop" in kinds, f"text={texts!r} kinds={kinds}")

        ev = parse_sse(call("OK_TOOL"))
        blocks = [json.loads(d)["content_block"]["type"] for e, d in ev if e == "content_block_start"]
        args = "".join(json.loads(d)["delta"]["partial_json"] for e, d in ev
                       if e == "content_block_delta" and '"input_json_delta"' in d)
        check("thinking→tool_use の順序", blocks == ["thinking", "tool_use"], f"got={blocks}")
        check("tool 引数", args and json.loads(args) == {"file_path": "/x"}, f"got={args!r}")

        ev = parse_sse(call("OK_MULTI"))
        names = [json.loads(d)["content_block"].get("name") for e, d in ev
                 if e == "content_block_start" and '"tool_use"' in d]
        idxs = [json.loads(d)["index"] for e, d in ev if e == "content_block_start"]
        check("非 0 始まり index の並列 tool", names == ["Read", "Grep"] and idxs == [0, 1], f"names={names} idx={idxs}")
    finally:
        proc.terminate()
        srv.shutdown()

    print()
    if fails:
        print(f"FAILED: {len(fails)} 件 -> {fails}")
        sys.exit(1)
    print("全て通過")


if __name__ == "__main__":
    main()
