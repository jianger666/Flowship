import { describe, expect, it } from "vitest";
import { createIsAppUrl, isLoopbackHostname } from "../electron-app/browser/app-origin.mjs";

const PORT = 8876;
const isAppUrl: (url: string) => boolean = createIsAppUrl(() => PORT);

describe("createIsAppUrl：只判本应用自己的 origin（回环别名 + 自己的端口）", () => {
  it("本应用 origin 的各种回环写法 → true", () => {
    expect(isAppUrl("http://127.0.0.1:8876/")).toBe(true);
    expect(isAppUrl("http://127.0.0.1:8876/tasks/abc?x=1#y")).toBe(true);
    expect(isAppUrl("http://localhost:8876/")).toBe(true);
    expect(isAppUrl("http://[::1]:8876/")).toBe(true);
    expect(isAppUrl("http://0.0.0.0:8876/")).toBe(true);
    expect(isAppUrl("http://127.0.0.2:8876/")).toBe(true); // 127/8 整段都是回环
    expect(isAppUrl("http://foo.localhost:8876/")).toBe(true); // *.localhost 被 Chromium 解析到回环
    expect(isAppUrl("http://localhost.:8876/")).toBe(true); // 末尾点
  });

  it("大小写 host / 非规范写法（URL 解析后规范化）→ true", () => {
    expect(isAppUrl("http://LOCALHOST:8876/")).toBe(true);
    expect(isAppUrl("HTTP://LocalHost:8876/x")).toBe(true);
    expect(isAppUrl("http://127.1:8876/")).toBe(true); // 127.1 → 127.0.0.1
    expect(isAppUrl("http://2130706433:8876/")).toBe(true); // 十进制 IP
    expect(isAppUrl("http://0x7f.0.0.1:8876/")).toBe(true);
    expect(isAppUrl("http://[0:0:0:0:0:0:0:1]:8876/")).toBe(true); // 展开写法的 ::1
  });

  it("https 也按端口判（指向自己 server 的路一条不留）", () => {
    expect(isAppUrl("https://127.0.0.1:8876/")).toBe(true);
    expect(isAppUrl("https://localhost:8876/")).toBe(true);
  });

  it("端口不同 → 放行（用户预览自己项目的 localhost:3000 等必须能开）", () => {
    expect(isAppUrl("http://localhost:3000/")).toBe(false);
    expect(isAppUrl("http://127.0.0.1:5173/")).toBe(false);
    expect(isAppUrl("http://[::1]:8000/")).toBe(false);
    expect(isAppUrl("http://0.0.0.0:8080/")).toBe(false);
    expect(isAppUrl("http://localhost:88760/")).toBe(false); // 端口前缀不算
    expect(isAppUrl("http://localhost:887/")).toBe(false);
    expect(isAppUrl("http://localhost:8775/")).toBe(false); // 约定端口的邻居不算
    expect(isAppUrl("http://localhost:8677/")).toBe(false);
  });

  // R1-30：旧版把 8776 明确写成「放行」，理由只有一句「不是本实例的端口」——不构成安全理由：
  // 同机另一个 Flowship（测试包 / 正式包 / 网页热更）是完整的应用 server，AI 导航过去再点按钮就绕过了「不碰应用自己」的红线。
  it("同机其他 Flowship 实例的约定端口（8676 / 8776 / 8876）一律拦，与本实例端口无关", () => {
    const asTest = createIsAppUrl(() => 8776); // 本实例是 FlowshipTest
    for (const port of [8676, 8776, 8876]) {
      for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "foo.localhost", "[::ffff:127.0.0.1]"]) {
        expect(isAppUrl(`http://${host}:${port}/`), `${host}:${port}（本实例 8876）`).toBe(true);
        expect(asTest(`http://${host}:${port}/`), `${host}:${port}（本实例 8776）`).toBe(true);
        expect(createIsAppUrl(() => 3456)(`https://${host}:${port}/x`), `${host}:${port}（本实例 3456）`).toBe(true);
      }
    }
    expect(isAppUrl("http://localhost:8776/")).toBe(true);
    expect(isAppUrl("http://localhost:8676/api/tasks")).toBe(true);
    // 只拦回环：别的主机的同号端口不是「本机的 Flowship」
    expect(isAppUrl("http://example.com:8776/")).toBe(false);
    expect(isAppUrl("http://192.168.1.5:8876/")).toBe(false);
    // 用户自己项目的端口照旧放行
    expect(asTest("http://localhost:3000/")).toBe(false);
  });

  it("端口按解析后的数字比：前导零 / 显式默认端口写法不能绕过", () => {
    expect(isAppUrl("http://localhost:08876/")).toBe(true);
    expect(isAppUrl("http://localhost:0008776/")).toBe(true);
    expect(isAppUrl("http://127.0.0.1:008676/x")).toBe(true);
    expect(isAppUrl("http://localhost:008877/")).toBe(false);
    expect(createIsAppUrl(() => 80)("http://localhost:0080/")).toBe(true);
    expect(createIsAppUrl(() => 443)("https://localhost:443/")).toBe(true);
  });

  it("缺省端口按协议补全：http 默认 80、https 默认 443，与自己的端口不同 → 放行", () => {
    expect(isAppUrl("http://localhost/")).toBe(false);
    expect(isAppUrl("https://localhost/")).toBe(false);
    expect(createIsAppUrl(() => 80)("http://localhost/")).toBe(true);
    expect(createIsAppUrl(() => 80)("http://localhost:80/")).toBe(true);
    expect(createIsAppUrl(() => 443)("https://127.0.0.1/")).toBe(true);
  });

  it("伪装 userinfo：按真实 host 判定，不按字符串前缀", () => {
    // 看着像本应用，真实 host 是 evil.com → 不是本应用（放行给 url-policy 的其它规则去管）
    expect(isAppUrl("http://127.0.0.1:8876@evil.com/")).toBe(false);
    expect(isAppUrl("http://localhost:8876@evil.com:8876/")).toBe(false);
    expect(isAppUrl("http://localhost:8876:pw@evil.com/")).toBe(false);
    // 反过来：userinfo 随便写，真实 host 是回环 + 自己端口 → 是本应用
    expect(isAppUrl("http://evil.com@127.0.0.1:8876/")).toBe(true);
    expect(isAppUrl("http://user:pw@localhost:8876/")).toBe(true);
    // userinfo 里的端口迷惑：真实端口不是自己的
    expect(isAppUrl("http://127.0.0.1:8876@localhost:3000/")).toBe(false);
  });

  it("类似但不是回环的主机 → 放行（不能做后缀 / 前缀匹配）", () => {
    expect(isAppUrl("http://localhost.evil.com:8876/")).toBe(false);
    expect(isAppUrl("http://evil-localhost:8876/")).toBe(false);
    expect(isAppUrl("http://127.0.0.1.evil.com:8876/")).toBe(false);
    expect(isAppUrl("http://128.0.0.1:8876/")).toBe(false);
    expect(isAppUrl("http://example.com:8876/")).toBe(false);
  });

  it("IPv6：::1 / :: / IPv4 映射回环 → true；其它 IPv6 → false", () => {
    expect(isAppUrl("http://[::]:8876/")).toBe(true);
    expect(isAppUrl("http://[::ffff:127.0.0.1]:8876/")).toBe(true); // URL 规范化为 ::ffff:7f00:1
    expect(isAppUrl("http://[::2]:8876/")).toBe(false);
    expect(isAppUrl("http://[2001:db8::1]:8876/")).toBe(false);
    expect(isAppUrl("http://[::1]:3000/")).toBe(false);
  });

  // R1-30：IPv6 解析成 16 字节后取内嵌 IPv4 再判 127/8 与 0.0.0.0，不再只认 `::ffff:7fxx:xxxx` 一个字面形状
  it("IPv6 内嵌 IPv4 的各种形态：映射 / 兼容 / SIIT，指向 127/8 或 0.0.0.0 → 当作本应用", () => {
    for (const u of [
      "http://[::ffff:0:0]:8876/", // 映射的 0.0.0.0（reviewer 举的例子）
      "http://[::ffff:0.0.0.0]:8876/", // 同上，点分写法
      "http://[0:0:0:0:0:ffff:0:0]:8876/", // 同上，展开写法
      "http://[::7f00:1]:8876/", // IPv4-compatible 的 127.0.0.1（reviewer 举的例子）
      "http://[::127.0.0.1]:8876/", // 同上，点分写法
      "http://[::7f01:2]:8876/", // 兼容形态的 127.1.0.2
      "http://[::ffff:7f12:3456]:8876/", // 映射形态的 127.18.52.86（整个 127/8）
      "http://[::ffff:0:7f00:1]:8876/", // SIIT 的 127.0.0.1
      "http://[::ffff:0:0:0]:8876/", // SIIT 的 0.0.0.0
      "http://[0000:0000:0000:0000:0000:0000:7f00:0001]:8876/", // 全展开的兼容形态
      "http://[::ffff:127.0.0.1]:8776/", // 约定端口 + 映射
    ]) {
      expect(isAppUrl(u), u).toBe(true);
    }
  });

  it("IPv6 内嵌的是别的 IPv4 / 不在这三种前缀里 → false（不误伤）", () => {
    for (const u of [
      "http://[::ffff:808:808]:8876/", // 映射的 8.8.8.8
      "http://[::ffff:0:1]:8876/", // 映射的 0.0.0.1：不是 0.0.0.0
      "http://[::ffff:8000:1]:8876/", // 映射的 128.0.0.1
      "http://[::8000:1]:8876/", // 兼容的 128.0.0.1
      "http://[::2]:8876/", // 兼容的 0.0.0.2
      "http://[::ffff:0:808:808]:8876/", // SIIT 的 8.8.8.8
      "http://[1::7f00:1]:8876/", // 前缀不是全零，不是内嵌形态
      "http://[2001:db8::7f00:1]:8876/",
      "http://[::1:7f00:1]:8876/", // = 0:0:0:0:0:1:7f00:1，第 6 组是 1 而不是 ffff / 0
      "http://[64:ff9b::7f00:1]:8876/", // NAT64：未验证会被路由到本机，刻意不判（见 isLoopbackHostname 注释）
    ]) {
      expect(isAppUrl(u), u).toBe(false);
    }
  });

  it("非 http(s) 协议 / 垃圾输入 → false（交给协议白名单去拒）", () => {
    expect(isAppUrl("about:blank#x")).toBe(false); // R1-30 负例：about: 没有 host / port，不是应用 origin
    expect(isAppUrl("file:///etc/passwd")).toBe(false);
    expect(isAppUrl("javascript:alert(1)")).toBe(false);
    expect(isAppUrl("about:blank")).toBe(false);
    expect(isAppUrl("ws://127.0.0.1:8876/")).toBe(false);
    expect(isAppUrl("/tasks/abc")).toBe(false);
    expect(isAppUrl("")).toBe(false);
    expect(isAppUrl("not a url")).toBe(false);
    expect(isAppUrl(undefined as unknown as string)).toBe(false);
  });

  it("端口是延迟取值：getPort 变化后判定跟着变（app 启动期才确定端口）", () => {
    // 用非约定端口（FLOWSHIP_PORT 自定义出来的）演示：8676 / 8776 / 8876 不受 getPort 影响，见上面的「约定端口」用例
    let port = 4321;
    const f = createIsAppUrl(() => port);
    expect(f("http://localhost:4321/")).toBe(true);
    expect(f("http://localhost:9000/")).toBe(false);
    port = 9000;
    expect(f("http://localhost:4321/")).toBe(false);
    expect(f("http://localhost:9000/")).toBe(true);
    expect(f("http://localhost:8876/")).toBe(true); // 约定端口：本实例端口变了也照拦
  });

  it("getPort 无效（undefined / NaN / 0 / 抛错）→ 非约定端口一律 false、不抛；约定端口（8676 / 8776 / 8876）仍然拦", () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect(createIsAppUrl(() => undefined as unknown as number)("http://localhost:3000/")).toBe(false);
    expect(createIsAppUrl(() => Number.NaN)("http://localhost:3000/")).toBe(false);
    expect(createIsAppUrl(() => 0)("http://localhost:0/")).toBe(false);
    expect(createIsAppUrl(boom)("http://localhost:3000/")).toBe(false);
    // getPort 失效时自己的端口无从得知，但这三个固定端口不依赖它（失败方向是「多拦」）
    expect(createIsAppUrl(() => undefined as unknown as number)("http://localhost:8876/")).toBe(true);
    expect(createIsAppUrl(() => Number.NaN)("http://localhost:8776/")).toBe(true);
    expect(createIsAppUrl(boom)("http://localhost:8676/")).toBe(true);
  });
});

describe("isLoopbackHostname", () => {
  it("回环主机名", () => {
    for (const h of ["127.0.0.1", "127.255.255.254", "0.0.0.0", "localhost", "LOCALHOST", "a.localhost", "[::1]", "[::]"]) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });
  it("R1-30：IPv6 内嵌 127/8 或 0.0.0.0（映射 / 兼容 / SIIT；方括号 / 点分 / 展开 / 大小写写法）", () => {
    for (const h of [
      "[::ffff:0:0]",
      "[::ffff:7f00:1]",
      "[::FFFF:7F00:1]",
      "[::ffff:127.0.0.1]",
      "[::7f00:1]",
      "[::127.0.0.1]",
      "[::ffff:0:7f00:1]",
      "[0:0:0:0:0:0:0:1]",
      "[0:0:0:0:0:0:0:0]",
      "[::ffff:7fff:ffff]",
      "::ffff:7f00:1", // 不带方括号的裸写法
      "::1",
    ]) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });
  it("非回环主机名", () => {
    for (const h of ["", "example.com", "localhost.com", "10.0.0.1", "192.168.1.1", "[2001:db8::1]", "128.0.0.1"]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
  it("R1-30：非回环 / 非法的 IPv6 写法 → false，且不抛", () => {
    for (const h of [
      "[::ffff:808:808]",
      "[::ffff:8000:1]",
      "[::8000:1]",
      "[::2]",
      "[::ffff:0:1]",
      "[1::1]",
      "[64:ff9b::7f00:1]", // NAT64：刻意不判
      "[::g]", // 非十六进制
      "[1:2:3:4:5:6:7]", // 少一组
      "[1:2:3:4:5:6:7:8:9]", // 多一组
      "[::1::2]", // 两个 ::
      "[:::1]",
      "[::ffff:1.2.3]", // 点分不是四段
      "[::ffff:300.0.0.1]", // 段超 255
      "[::ffff:127.0.0.1%eth0]", // zone id
      "[12345::1]", // 组超 4 位
    ]) {
      expect(() => isLoopbackHostname(h), h).not.toThrow();
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});
