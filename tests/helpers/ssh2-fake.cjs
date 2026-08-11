/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * ssh2 mock（ssh-exec CLI 测试用）：由环境变量驱动行为、可把 connect 参数 dump 到文件
 */
const fs = require("node:fs");

class FakeClient {
  on(ev, cb) {
    this._h = this._h || {};
    this._h[ev] = cb;
    return this;
  }
  connect(opts) {
    this._hostVerifier = opts.hostVerifier;
    const dump = process.env.SSH2_FAKE_DUMP;
    if (dump) {
      try {
        fs.writeFileSync(dump, JSON.stringify(opts));
      } catch {
        // dump 失败不阻塞
      }
    }
    const mode = process.env.SSH2_FAKE_MODE || "ok";
    if (mode === "auth-fail") {
      process.nextTick(() =>
        this._h.error &&
        this._h.error(new Error("All configured authentication methods failed")),
      );
    } else if (mode === "host-verify") {
      // 与真实 ssh2 一致：hostVerifier 收到 raw key blob（文本行的 base64 部分解码）
      const hostKeyText =
        process.env.SSH2_FAKE_HOST_KEY ||
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
      const key = Buffer.from(hostKeyText.split(/\s+/)[1] || "", "base64");
      const ok =
        typeof this._hostVerifier !== "function" ||
        this._hostVerifier(key, () => {});
      process.nextTick(() => {
        if (!ok && this._h.error) {
          this._h.error(new Error("Host key verification failed"));
        } else if (this._h.ready) {
          this._h.ready();
        }
      });
    } else {
      process.nextTick(() => this._h.ready && this._h.ready());
    }
  }
  end() {}
  exec(_cmd, cb) {
    const dump = process.env.SSH2_FAKE_DUMP;
    if (dump) {
      try {
        const raw = fs.readFileSync(dump, "utf8");
        const obj = raw.trim() ? JSON.parse(raw) : {};
        obj.cmd = _cmd;
        fs.writeFileSync(dump, JSON.stringify(obj));
      } catch {
        // dump 失败不阻塞
      }
    }
    const stream = {
      on: (ev, h) => {
        if (ev === "data") h(Buffer.from(process.env.SSH2_FAKE_STDOUT || ""));
        if (ev === "error" && process.env.SSH2_FAKE_MODE === "stream-error") {
          process.nextTick(() => h(new Error("remote channel exploded")));
        }
        if (ev === "close") {
          process.nextTick(() => h(Number(process.env.SSH2_FAKE_EXIT || 0)));
        }
        return stream;
      },
      stderr: {
        on: (ev, h) => {
          if (ev === "data") {
            h(Buffer.from(process.env.SSH2_FAKE_STDERR || ""));
          }
          return stream;
        },
      },
    };
    cb(null, stream);
  }
}

exports.Client = FakeClient;
