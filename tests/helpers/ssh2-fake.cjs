/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * ssh2 mock（ssh-exec CLI 测试用）：由环境变量驱动行为、可把 connect 参数 dump 到文件
 *
 * 环境变量：
 *   SSH2_FAKE_MODE   ok | auth-fail | host-verify | stream-error | connect-throw | exec-hang | sig-fail
 *   SSH2_FAKE_DUMP   connect 参数 / 命令 / destroy 记录写到这个文件
 *   SSH2_FAKE_HOST_KEY      host-verify：服务端出示的单把 key（`<type> <base64>`）
 *   SSH2_FAKE_SERVER_KEYS   host-verify：服务端有的多把 key，JSON `{ "<type>": "<type> <base64>" }`；
 *                           按 connect 的 algorithms.serverHostKey（缺省 ssh2 默认顺序）协商出一把，
 *                           协不出 → 与真实 ssh2 一致报 `Handshake failed: no matching host key format`
 */
const fs = require("node:fs");
// 真实 ssh2 的 parseKey：请求串不是裸 "ssh2"，不会被 preload 再次拦截成本 fake
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");

/** 与真实 ssh2 SUPPORTED_SERVER_HOST_KEY 一致（默认偏好序 + ssh-dss） */
const DEFAULT_SERVER_HOST_KEY = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
];
const SUPPORTED_SERVER_HOST_KEY = [...DEFAULT_SERVER_HOST_KEY, "ssh-dss"];

/** 签名算法 → key 类型（rsa-sha2-* 与 ssh-rsa 是同一把 RSA key 的不同签名算法） */
const keyTypeOfAlgo = (algo) =>
  algo === "rsa-sha2-512" || algo === "rsa-sha2-256" ? "ssh-rsa" : algo;

/** 读-改-写 dump 文件（connect 写完整参数，其后的 exec / destroy 往里追加字段） */
const patchDump = (patch) => {
  const dump = process.env.SSH2_FAKE_DUMP;
  if (!dump) return;
  try {
    const raw = fs.readFileSync(dump, "utf8");
    const obj = raw.trim() ? JSON.parse(raw) : {};
    fs.writeFileSync(dump, JSON.stringify({ ...obj, ...patch }));
  } catch {
    // dump 失败不阻塞
  }
};

class FakeClient {
  on(ev, cb) {
    this._h = this._h || {};
    this._h[ev] = cb;
    return this;
  }
  connect(opts) {
    // 与真实 ssh2 Client.connect 一致：privateKey 解析失败 / 不含私钥 → 同步 throw
    //（加密私钥且没给 passphrase 也是这条路径，整条连接都建不起来）
    if (opts.privateKey) {
      let key = parseKey(opts.privateKey, opts.passphrase);
      if (key instanceof Error) {
        throw new Error(`Cannot parse privateKey: ${key.message}`);
      }
      if (Array.isArray(key)) key = key[0];
      if (key.getPrivatePEM() === null) {
        throw new Error("privateKey value does not contain a (valid) private key");
      }
    }
    // 与真实 ssh2 一致：algorithms.serverHostKey 给了精确列表，含不支持的名字 → 同步 throw
    const wantedAlgos = opts.algorithms?.serverHostKey;
    if (Array.isArray(wantedAlgos) && wantedAlgos.length > 0) {
      for (const a of wantedAlgos) {
        if (!SUPPORTED_SERVER_HOST_KEY.includes(a)) {
          throw new Error(`Unsupported algorithm: ${a}`);
        }
      }
    }
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
    if (mode === "connect-throw") {
      throw new Error("fake connect exploded");
    }
    if (mode === "sig-fail") {
      // 握手签名校验失败（与 hostVerifier 拒绝不同：这不是 known_hosts 的问题）
      process.nextTick(() =>
        this._h.error &&
        this._h.error(new Error("Handshake failed: signature verification failed")),
      );
    } else if (mode === "auth-fail") {
      process.nextTick(() =>
        this._h.error &&
        this._h.error(new Error("All configured authentication methods failed")),
      );
    } else if (mode === "host-verify") {
      // 与真实 ssh2 一致：hostVerifier 收到 raw key blob（文本行的 base64 部分解码）
      let hostKeyText =
        process.env.SSH2_FAKE_HOST_KEY ||
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
      if (process.env.SSH2_FAKE_SERVER_KEYS) {
        // 服务端有多把 key：按客户端接受的算法列表（缺省 ssh2 默认序）挑第一个服务端有的
        const serverKeys = JSON.parse(process.env.SSH2_FAKE_SERVER_KEYS);
        const clientAlgos =
          Array.isArray(wantedAlgos) && wantedAlgos.length > 0
            ? wantedAlgos
            : DEFAULT_SERVER_HOST_KEY;
        const picked = clientAlgos.find((a) => serverKeys[keyTypeOfAlgo(a)]);
        if (!picked) {
          process.nextTick(() =>
            this._h.error &&
            this._h.error(new Error("Handshake failed: no matching host key format")),
          );
          return;
        }
        hostKeyText = serverKeys[keyTypeOfAlgo(picked)];
      }
      const key = Buffer.from(hostKeyText.split(/\s+/)[1] || "", "base64");
      const ok =
        typeof this._hostVerifier !== "function" ||
        this._hostVerifier(key, () => {});
      process.nextTick(() => {
        if (!ok && this._h.error) {
          // 与真实 ssh2 hostVerifier 返回 false 时的报错文案一致
          this._h.error(new Error("Host denied (verification failed)"));
        } else if (this._h.ready) {
          this._h.ready();
        }
      });
    } else {
      process.nextTick(() => this._h.ready && this._h.ready());
    }
  }
  end() {}
  /** 真实 ssh2 的 destroy()：直接销毁底层 socket（对端挂死时 end() 关不掉） */
  destroy() {
    patchDump({ destroyed: true });
  }
  exec(_cmd, cb) {
    patchDump({ cmd: _cmd });
    const stream = {
      on: (ev, h) => {
        if (ev === "data") {
          // 大输出走文件：Linux 单个环境变量上限 128KB（MAX_ARG_STRLEN），150KB+ 的 env 会让 spawn 直接 E2BIG
          const f = process.env.SSH2_FAKE_STDOUT_FILE;
          h(f ? fs.readFileSync(f) : Buffer.from(process.env.SSH2_FAKE_STDOUT || ""));
        }
        if (ev === "error" && process.env.SSH2_FAKE_MODE === "stream-error") {
          process.nextTick(() => h(new Error("remote channel exploded")));
        }
        if (ev === "close" && process.env.SSH2_FAKE_MODE !== "exec-hang") {
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
// ssh-exec 用 utils.parseKey 预检本机私钥：fake 里直接给真实实现，测试才测得到真实的加密 key 行为
exports.utils = { parseKey };
