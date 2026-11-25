// ============================================================================
// Flowship 解锁组件（Windows）
//
// 作用：电脑锁屏时，替 Flowship 在 Windows 登录界面里输入用户保存的开机密码，让 AI 能继续操作电脑。
// 为什么需要它：Windows 锁屏时「输入桌面」切到 Winlogon，普通用户进程既注入不了键盘、也碰不到锁屏界面，
// 只有 SYSTEM 身份的进程才能在那个桌面上输入。所以这里是一个以 SYSTEM 身份运行的小程序，分三种模式：
//   service  常驻（计划任务，开机启动）。命名管道服务端：只接受安装时登记的那个 Windows 账户；保存 / 删除 / 校验开机密码
//            （Windows 数据保护加密，存在只有 SYSTEM 和管理员能读的目录里）；限速；需要解锁时拉起 typist。
//   typist   一次性。由 service 在「控制台会话的 winlogon 桌面」上拉起：确认电脑确实锁着 → 唤醒锁屏 → 读密码 → 输入 → 回车 →
//            等桌面切回 Default。通过退出码告诉 service 结果。密码只在这个进程的内存里短暂存在，不进命令行 / 环境变量 / 日志。
//   selftest 安装器编译完之后跑一次：确认类型能加载、系统 API 解析得到、数据保护可用。不碰任何真实凭据。
//
// 硬规矩：
// - 一次解锁最多输入一次密码，绝不重试（输错会触发账户锁定）；失败后 10 分钟内 service 拒绝再试（落盘，重启 service 也不清零；
//   冷却状态写不进去 / 读不懂 / 读不了时一律往「冷却」那边倒，只有状态文件不存在或已过期才放行）。
// - 电脑不是锁屏状态（输入桌面是 Default）就一个键都不按。
// - 输入桌面不是 Default 也不一定是锁屏：UAC 权限确认、Ctrl+Alt+Del 这类安全桌面同样在 Winlogon 上，往里输开机密码再回车等于替用户点了「是」。
//   所以只有会话的锁定标志（WTSSessionInfoEx）明确读到「已锁定」才输入；读不出来 / 没锁定就一个键都不按（SECURE_DESKTOP / DESKTOP_ERROR）。
// - 日志（public\helper.log，用户可读）只记动作和结果码，永远不记密码或任何和密码有关的内容。
// - 只用 C# 5 语法：Windows PowerShell 5.1 的 Add-Type 自带的是 .NET Framework 4.x 的老编译器。
//
// 协议（命名管道，UTF-8，一行一条消息，LF 结尾）：
//   请求  FS1<TAB>verb[<TAB>key=value]...      value 用百分号编码（Uri.EscapeDataString）
//   响应  FS1<TAB>ok|err<TAB>code=XXX[<TAB>key=value]...
// verb：ping / status / set(pw) / clear / check / unlock。协议改动要和 protocol.mjs 一起改。
// ============================================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Flowship.Unlock
{
    internal static class Const
    {
        /// <summary>
        /// 组件版本：和 protocol.mjs 的 HELPER_VERSION 一致（不一致设置页会提示重新安装）。
        /// v2：冷却恢复语义（读不了状态文件从修改时间起算、Clear 返回 bool、截止时刻远在未来时夹紧而不是封顶）；
        /// 保存密码清不掉冷却时回 COOLDOWN_NOT_CLEARED（带 saved / wait）；
        /// 删凭据 / 清冷却不再用 File.Exists 判断「有没有」（它吞权限错误，会谎报「已清除」）。
        /// 旧版 service 不是这些行为：装着 v1 的机器必须重装一次（设置页看到版本不一致会提示）。
        /// v3：保存密码时冷却记录清不掉、但它已经过期（Remaining 为 0）——不再回 COOLDOWN_NOT_CLEARED（那是误报），只记日志、回 OK；
        /// 冷却确实还在才回 COOLDOWN_NOT_CLEARED（Cooldown.StillBlockedSeconds）。旧版 service 对这种情况仍然误报，所以装着 v2 的机器要重装一次。
        /// v4：凭据「有没有」（CredStore.Exists / Load / Save）不再用 File.Exists——它吞权限错误，把「看不见」当成「没有」：状态页回「未保存」、
        /// 解锁回 NO_CREDENTIAL（让用户白白去重新保存），而密码其实还在。现在直接取属性 / 直接读，只有 FileNotFound / DirectoryNotFound 才算没有；
        /// 其余错误 Exists 按「可能有」回 true、Load 抛出去（走调用方现成的「读不出来」分支）。旧版 service 仍是 File.Exists 的行为，所以装着 v3 的机器要重装一次。
        /// </summary>
        internal const int Version = 4;
        /// <summary>协议版本：和 protocol.mjs 的 PROTOCOL_VERSION 一致（v2：新增结果码 COOLDOWN_NOT_CLEARED 与 saved / wait 字段；v3：DoSet 只在冷却确实还在时才回 COOLDOWN_NOT_CLEARED；v4：协议本身没变，随组件版本同步升，让装着 v3 的机器被提示升级）</summary>
        internal const int Proto = 4;
        internal const string Tag = "FS1";
        internal const int MaxLine = 4096;
        internal const int MaxPasswordLength = 127;
        internal const int CooldownSeconds = 600;
        /// <summary>typist 最长跑多久（唤醒 + 输入 + 等解锁），超时就结束它</summary>
        internal const int TypistTimeoutMs = 40000;
        internal const int ClientTimeoutMs = 90000;
    }

    internal static class Paths
    {
        internal static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Flowship\\unlock");
        internal static readonly string Pub = Path.Combine(Root, "public");
        internal static string Cred { get { return Path.Combine(Root, "cred.bin"); } }
        internal static string Config { get { return Path.Combine(Root, "config.txt"); } }
        internal static string State { get { return Path.Combine(Root, "state.txt"); } }
        internal static string PipeFile { get { return Path.Combine(Pub, "pipe.txt"); } }
        internal static string LogFile { get { return Path.Combine(Pub, "helper.log"); } }
    }

    /// <summary>日志：只记动作和结果码。目录不存在就不记（不替安装器建目录，免得建出权限不对的目录）</summary>
    internal static class Log
    {
        static readonly object Gate = new object();

        internal static void Write(string level, string message)
        {
            try
            {
                lock (Gate)
                {
                    if (!Directory.Exists(Paths.Pub)) return;
                    string file = Paths.LogFile;
                    FileInfo info = new FileInfo(file);
                    if (info.Exists && info.Length > 262144)
                    {
                        string old = file + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(file, old);
                    }
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " [" + level + "] " + message + "\r\n";
                    File.AppendAllText(file, line, new UTF8Encoding(false));
                }
            }
            catch
            {
                // 日志写不进去不能影响主流程
            }
        }
    }

    /// <summary>
    /// 能输入的字符表（美式键盘）：字符 → 虚拟键码 + 是否要按 Shift。
    /// KeyChars / ShiftChars / KeyVks 三者按下标一一对应，protocol.mjs 里有同样的表，测试逐项对账。
    /// </summary>
    internal static class Keymap
    {
        const string KeyChars = "abcdefghijklmnopqrstuvwxyz0123456789 ;=,-./`[\\]'";
        const string ShiftChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ)!@#$%^&*( :+<_>?~{|}\"";
        static readonly byte[] KeyVks = new byte[]
        {
            0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D,
            0x4E, 0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A,
            0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
            0x20,
            0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xDB, 0xDC, 0xDD, 0xDE
        };

        internal struct KeyStroke
        {
            internal byte Vk;
            internal bool Shift;
        }

        static readonly Dictionary<char, KeyStroke> Map = Build();

        static Dictionary<char, KeyStroke> Build()
        {
            Dictionary<char, KeyStroke> map = new Dictionary<char, KeyStroke>();
            for (int i = 0; i < KeyChars.Length; i++)
            {
                KeyStroke plain = new KeyStroke();
                plain.Vk = KeyVks[i];
                plain.Shift = false;
                map[KeyChars[i]] = plain;
                if (ShiftChars[i] != KeyChars[i])
                {
                    KeyStroke shifted = new KeyStroke();
                    shifted.Vk = KeyVks[i];
                    shifted.Shift = true;
                    map[ShiftChars[i]] = shifted;
                }
            }
            return map;
        }

        internal static bool TryGet(char c, out KeyStroke stroke)
        {
            return Map.TryGetValue(c, out stroke);
        }

        internal static bool IsTypeable(char[] password)
        {
            if (password == null || password.Length == 0 || password.Length > Const.MaxPasswordLength) return false;
            for (int i = 0; i < password.Length; i++)
            {
                if (!Map.ContainsKey(password[i])) return false;
            }
            return true;
        }

        internal static int KeyCount { get { return KeyChars.Length; } }
    }

    /// <summary>开机密码的存取：Windows 数据保护（本机范围）加密，文件在只有 SYSTEM / 管理员能读的目录里</summary>
    internal static class CredStore
    {
        static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Flowship.Unlock.v1");

        /// <summary>
        /// 有没有保存开机密码。不用 File.Exists：它遇到「没权限 / 路径访问被拒」也返回 false（吞掉错误），把「看不见」当成「没有」——
        /// 状态页回「未保存」、解锁回 NO_CREDENTIAL（让用户白白去重新保存），而密码其实还在。
        /// 直接取文件属性：只有 FileNotFoundException / DirectoryNotFoundException 才算「没有」；其余错误一律按「可能有」回 true，
        /// 让后面的 Load 去真读——读不出来就走调用方现成的「读不出来」那条分支（CRED_UNREADABLE / typist 的 CredentialUnreadable），不假装没有。
        /// </summary>
        internal static bool Exists()
        {
            try
            {
                File.GetAttributes(Paths.Cred);
                return true;
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
            catch (Exception)
            {
                return true;
            }
        }

        internal static void Save(char[] password)
        {
            byte[] plain = Encoding.UTF8.GetBytes(password);
            try
            {
                WriteSealed(ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine));
            }
            finally
            {
                Array.Clear(plain, 0, plain.Length);
            }
        }

        /// <summary>
        /// 把加密好的字节落盘：先写临时文件，再原子替换 / 移动到位。
        /// 不先问 File.Exists 来挑 Replace 还是 Move：它遇到「没权限」也返回 false（吞掉错误），把「看不见」当成「没有」。
        /// 这里先试 File.Replace（目标在 = 原子替换）；目标不存在（第一次保存）时 Replace 会失败，再 File.Move——
        /// 不去猜 Replace 因为什么失败、抛的是哪种异常：Move 在目标其实还在时一定抛 IOException，所以既不会悄悄覆盖、也不会谎报成功，调用方回 STORE_FAILED。
        /// 失败时临时文件（只是密文）留着，下一次保存会覆盖它、删除密码时一并删掉。
        /// </summary>
        internal static void WriteSealed(byte[] sealedBytes)
        {
            string temp = Paths.Cred + ".tmp";
            File.WriteAllBytes(temp, sealedBytes);
            try
            {
                File.Replace(temp, Paths.Cred, null);
            }
            catch (Exception)
            {
                File.Move(temp, Paths.Cred);
            }
        }

        /// <summary>读出密码；没有文件返回 null；读不了 / 文件坏了 / 解不开抛异常（调用方只记「读不出来」，不记内容）</summary>
        internal static char[] Load()
        {
            byte[] sealedBytes = ReadSealed();
            if (sealedBytes == null) return null;
            byte[] plain = ProtectedData.Unprotect(sealedBytes, Entropy, DataProtectionScope.LocalMachine);
            try
            {
                return Encoding.UTF8.GetChars(plain);
            }
            finally
            {
                Array.Clear(plain, 0, plain.Length);
            }
        }

        /// <summary>
        /// 读出加密后的字节；只有「文件 / 目录不存在」算没有（返回 null），其余（没权限 / 被占用 / ……）原样抛出去。
        /// 不先问 File.Exists：它把「看不见」也当成「没有」，调用方就会回 NO_CREDENTIAL、让用户白白去重新保存。
        /// </summary>
        internal static byte[] ReadSealed()
        {
            try
            {
                return File.ReadAllBytes(Paths.Cred);
            }
            catch (FileNotFoundException)
            {
                return null;
            }
            catch (DirectoryNotFoundException)
            {
                return null;
            }
        }

        /// <summary>
        /// 删掉保存的开机密码。不先问 File.Exists：它遇到「没权限 / 路径访问被拒」也返回 false（吞掉错误），文件明明还在、这里却当成没有而跳过，
        /// 调用方就会回「已清除」——密码其实还留着。File.Delete 对不存在的文件不抛；权限 / 占用这类真错误让它抛出去，调用方回 STORE_FAILED。
        /// </summary>
        internal static void Delete()
        {
            DeleteIfPresent(Paths.Cred);
            DeleteIfPresent(Paths.Cred + ".tmp");
        }

        static void DeleteIfPresent(string path)
        {
            try
            {
                File.Delete(path);
            }
            catch (DirectoryNotFoundException)
            {
                // 目录都不存在：本来就没有这个文件
            }
        }
    }

    /// <summary>
    /// 解锁失败后的冷却（落盘：重启 service 也不清零）。重新保存开机密码会清掉它。
    /// 宁可多冷却也不能少冷却（连续输错密码会让账户被锁定），所以出问题时一律往「冷却」那边倒：
    /// - 截止时刻同时记在进程内存里：状态文件写不进去 / 被删 / 被改，这次 service 运行期间冷却照样生效；
    /// - 状态文件在、内容读不懂（写了一半 / 被改过）：按「文件最后修改时间起算一整段冷却」；
    /// - 状态文件在、却读不了（被占用 / 没权限）：同样从最后修改时间起算（修改时间是元数据，通常照样读得到；Start 只在失败的那一刻写一次，
    ///   所以「修改时间 + 一整段」≈ 当时记下的截止时刻）；连它也拿不到，就从第一次发现读不了的时刻起算——总之会倒计时，
    ///   不能每次都回一整段（那样状态文件一直读不了，冷却就永远不结束，重新保存密码也没用）；
    /// - 状态文件在、但看不见（所在目录没权限）：File.Exists 对这种情况也返回 false（吞掉错误），所以不能靠它判断「文件不存在」——
    ///   直接读，只有 FileNotFound / DirectoryNotFound 才算不存在，其余一律当「读不了」（有冷却）；
    /// - 读到的截止时刻比「现在 + 一整段」还远（状态文件被改过 / 时钟被往回拨过）：夹到「第一次发现时 + 一整段」并固定下来（见 clampedUntilTicks），
    ///   之后照常倒计时、照常结束——而不是每次都回一整段（封顶）：那样读到一个远未来的值，冷却就永远回满格、永远结束不了；
    /// - 只有「文件不存在」「记录的截止时刻已经过了」或「内容是 Clear 写的已清除标记 0」才算没有冷却。
    /// </summary>
    internal static class Cooldown
    {
        static readonly object Gate = new object();
        /// <summary>进程内的冷却截止时刻（UTC ticks），0 = 没有</summary>
        static long memoryUntilTicks = 0;
        /// <summary>
        /// 读到的截止时刻比「现在 + 一整段」还远时，被夹到的那个截止时刻（UTC ticks）：第一次发现时定下、之后固定，所以会倒计时、会结束；0 = 没有这种情况。
        /// 只有 Start（新一轮冷却）/ Clear 重置：不重置的话，旧的、已过期的夹紧值会把之后新的冷却当场判成「已结束」。
        /// </summary>
        static long clampedUntilTicks = 0;
        /// <summary>状态文件读不了、连修改时间也拿不到时：第一次发现它读不了的时刻（UTC ticks），之后从这里起算一整段冷却；0 = 没有这种情况</summary>
        static long unreadableSinceTicks = 0;
        /// <summary>「状态文件读不了」的日志只在第一次发现时写一次（设置页每 3 秒问一次状态，别刷屏）</summary>
        static bool unreadableLogged = false;

        /// <summary>状态文件又能读了 / 被重写 / 被清掉：「读不了」的记忆作废</summary>
        static void ForgetUnreadable()
        {
            unreadableSinceTicks = 0;
            unreadableLogged = false;
        }

        static TimeSpan LeftUntil(DateTime untilUtc)
        {
            DateTime now = DateTime.UtcNow;
            DateTime cap = now.AddSeconds(Const.CooldownSeconds);
            if (untilUtc > cap)
            {
                // 比规定的更长，不可能是我们写的（状态文件被改过 / 时钟被往回拨过）：夹到「第一次发现时的现在 + 一整段」并固定下来，
                // 之后从这个固定的截止时刻倒计时。时钟又被往回拨、让固定下来的值反而比现在的上限还远时，再往回夹一次——冷却永远不超过一整段。
                // （以前这里直接回「一整段」：每次读都是满格，远未来的值会让冷却永远结束不了。）
                // 到这里 clampedUntilTicks <= cap.Ticks < untilUtc.Ticks，所以直接用它
                if (clampedUntilTicks == 0 || clampedUntilTicks > cap.Ticks) clampedUntilTicks = cap.Ticks;
                untilUtc = new DateTime(clampedUntilTicks, DateTimeKind.Utc);
            }
            TimeSpan left = untilUtc - now;
            return left > TimeSpan.Zero ? left : TimeSpan.Zero;
        }

        static TimeSpan Longer(TimeSpan a, TimeSpan b)
        {
            return a > b ? a : b;
        }

        /// <summary>状态文件读不了时用来起算冷却的时刻：优先文件修改时间；拿不到就用「第一次发现读不了」的时刻（记在内存里，之后固定）</summary>
        static DateTime UnreadableBasis()
        {
            try
            {
                DateTime written = File.GetLastWriteTimeUtc(Paths.State);
                // 文件不存在时 .NET 返回 1601-01-01：那不是有效的修改时间
                if (written.Year >= 2000) return written;
            }
            catch
            {
            }
            if (unreadableSinceTicks == 0) unreadableSinceTicks = DateTime.UtcNow.Ticks;
            return new DateTime(unreadableSinceTicks, DateTimeKind.Utc);
        }

        internal static TimeSpan Remaining()
        {
            lock (Gate)
            {
                TimeSpan fromMemory = memoryUntilTicks > 0 ? LeftUntil(new DateTime(memoryUntilTicks, DateTimeKind.Utc)) : TimeSpan.Zero;
                try
                {
                    // 不先问 File.Exists：状态文件在、但所在目录没权限时它也返回 false（吞掉错误），那会被当成「没有冷却」——少冷却。
                    // 直接读：只有 FileNotFound / DirectoryNotFound 才是真的不存在，其余（没权限 / 被占用 / 路径异常）落到下面的 catch，按「读不了」处理（有冷却）
                    string content;
                    try
                    {
                        content = File.ReadAllText(Paths.State);
                    }
                    catch (FileNotFoundException)
                    {
                        ForgetUnreadable();
                        return fromMemory;
                    }
                    catch (DirectoryNotFoundException)
                    {
                        ForgetUnreadable();
                        return fromMemory;
                    }
                    long ticks;
                    if (long.TryParse(content.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out ticks))
                    {
                        // 0 = Clear 在删不掉状态文件时改写成的「已清除」标记
                        if (ticks == 0)
                        {
                            ForgetUnreadable();
                            return fromMemory;
                        }
                        if (ticks > 0 && ticks <= DateTime.MaxValue.Ticks)
                        {
                            ForgetUnreadable();
                            return Longer(fromMemory, LeftUntil(new DateTime(ticks, DateTimeKind.Utc)));
                        }
                    }
                    // 内容读不懂：从文件最后一次被写的时刻起算一整段冷却
                    ForgetUnreadable();
                    return Longer(fromMemory, LeftUntil(File.GetLastWriteTimeUtc(Paths.State).AddSeconds(Const.CooldownSeconds)));
                }
                catch (Exception ex)
                {
                    // 文件在、内容读不了：不能当成「没有冷却」，也不能每次都回一整段（永不倒计时）——从修改时间 / 第一次发现的时刻起算
                    if (!unreadableLogged)
                    {
                        unreadableLogged = true;
                        Log.Write("warn", "读冷却状态失败，按「从最后修改时间起算」处理：" + ex.GetType().Name);
                    }
                    return Longer(fromMemory, LeftUntil(UnreadableBasis().AddSeconds(Const.CooldownSeconds)));
                }
            }
        }

        internal static void Start()
        {
            lock (Gate)
            {
                DateTime until = DateTime.UtcNow.AddSeconds(Const.CooldownSeconds);
                // 先记内存：下面落盘失败也照样生效
                memoryUntilTicks = until.Ticks;
                // 新一轮冷却：之前夹过的记忆作废（旧的、已过期的夹紧值会把新的冷却当场判成「已结束」）
                clampedUntilTicks = 0;
                ForgetUnreadable();
                try
                {
                    File.WriteAllText(Paths.State, until.Ticks.ToString(CultureInfo.InvariantCulture));
                }
                catch (Exception ex)
                {
                    Log.Write("warn", "写冷却状态失败（这次 service 运行期间冷却仍然有效，重启后会丢）：" + ex.GetType().Name);
                }
            }
        }

        /// <summary>
        /// 清掉冷却（内存 + 状态文件）。返回 true = 确认清掉了；false = 状态文件删不掉、也改写不了：
        /// 冷却照旧生效到截止时刻（往安全的方向倒），调用方要如实告诉用户，不能当成已经恢复。
        /// </summary>
        internal static bool Clear()
        {
            lock (Gate)
            {
                memoryUntilTicks = 0;
                clampedUntilTicks = 0;
                ForgetUnreadable();
                try
                {
                    // 不先问 File.Exists：它遇到「没权限 / 路径访问被拒」也返回 false（吞掉错误），文件明明还在、这里却当成已清掉并返回 true——
                    // 调用方（保存 / 清除密码）就会告诉用户冷却已经恢复。File.Delete 对不存在的文件不抛；真错误让它抛出去，走下面的改写 / 返回 false
                    try
                    {
                        File.Delete(Paths.State);
                    }
                    catch (DirectoryNotFoundException)
                    {
                        // 目录都不存在：本来就没有状态文件
                    }
                    return true;
                }
                catch (Exception ex)
                {
                    Log.Write("warn", "清冷却状态失败（删除）：" + ex.GetType().Name);
                }
                try
                {
                    // 删不掉就改写成「已清除」标记（Remaining 把内容 0 读成没有冷却）：光留着的话，下一次解锁请求照样被冷却挡住，
                    // 而用户刚被告知重新保存开机密码可以立即恢复
                    File.WriteAllText(Paths.State, "0");
                    return true;
                }
                catch (Exception ex)
                {
                    Log.Write("warn", "清冷却状态失败（改写成已清除标记）：" + ex.GetType().Name);
                    return false;
                }
            }
        }

        /// <summary>
        /// Clear() 返回 false 之后调用：冷却现在还要挡多少秒（向上取整；0 = 已经没有冷却在生效）。
        /// 「清不掉」不等于「冷却还在」：状态文件里可能只是一个早已过期的时间戳（文件又被占用、删不掉也改写不了），
        /// 这时根本没有冷却在挡人，调用方不能回「冷却没清掉」去吓用户。读不了状态文件时 Remaining 会按修改时间起算（不是 0），所以这里不会把「读不了」当成「没有」。
        /// </summary>
        internal static int StillBlockedSeconds()
        {
            return (int)Math.Ceiling(Remaining().TotalSeconds);
        }
    }

    /// <summary>系统 API 声明</summary>
    internal static class Native
    {
        internal const uint TOKEN_ALL_ACCESS = 0xF01FF;
        internal const uint MAXIMUM_ALLOWED = 0x02000000;
        internal const int SecurityImpersonation = 2;
        internal const int TokenPrimary = 1;
        internal const int TokenSessionId = 12;
        internal const uint CREATE_NO_WINDOW = 0x08000000;
        internal const uint WAIT_OBJECT_0 = 0;
        internal const uint DESKTOP_READOBJECTS = 0x0001;
        internal const int UOI_NAME = 2;
        internal const uint INPUT_MOUSE = 0;
        internal const uint INPUT_KEYBOARD = 1;
        internal const uint KEYEVENTF_KEYUP = 0x0002;
        internal const uint MOUSEEVENTF_MOVE = 0x0001;

        [StructLayout(LayoutKind.Sequential)]
        internal struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        internal struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
            [FieldOffset(0)]
            public KEYBDINPUT ki;
            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct LUID
        {
            public uint LowPart;
            public int HighPart;
        }

        /// <summary>只带一项特权的 TOKEN_PRIVILEGES（PrivilegeCount = 1，后面跟一个 LUID_AND_ATTRIBUTES）</summary>
        [StructLayout(LayoutKind.Sequential)]
        internal struct TOKEN_PRIVILEGES
        {
            public uint PrivilegeCount;
            public LUID Luid;
            public uint Attributes;
        }

        internal const uint SE_PRIVILEGE_ENABLED = 0x00000002;
        internal const int ERROR_NOT_ALL_ASSIGNED = 1300;

        [DllImport("advapi32.dll", EntryPoint = "LookupPrivilegeValueW", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool LookupPrivilegeValue(string systemName, string name, out LUID luid);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AdjustTokenPrivileges(IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool disableAll, ref TOKEN_PRIVILEGES newState, uint bufferLength, IntPtr previousState, IntPtr returnLength);

        [DllImport("kernel32.dll")]
        internal static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytesReturned);

        [DllImport("wtsapi32.dll")]
        internal static extern void WTSFreeMemory(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetNamedPipeClientSessionId(IntPtr pipe, out uint sessionId);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int infoLength);

        [DllImport("advapi32.dll", EntryPoint = "CreateProcessAsUserW", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcessAsUser(IntPtr token, string applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [DllImport("user32.dll")]
        internal static extern uint MapVirtualKey(uint code, uint mapType);

        [DllImport("user32.dll")]
        internal static extern short GetKeyState(int virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint desiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr GetThreadDesktop(uint threadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseDesktop(IntPtr desktop);

        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetUserObjectInformation(IntPtr obj, int index, byte[] info, int length, out int lengthNeeded);
    }

    /// <summary>桌面名：输入桌面是 Default = 电脑没锁屏；Winlogon = 锁屏（或 UAC 提示等安全桌面）</summary>
    internal static class Desktops
    {
        internal static string NameOf(IntPtr desktop)
        {
            byte[] buffer = new byte[512];
            int needed;
            if (!Native.GetUserObjectInformation(desktop, Native.UOI_NAME, buffer, buffer.Length, out needed)) return null;
            int length = Math.Max(0, Math.Min(needed, buffer.Length) - 2);
            return Encoding.Unicode.GetString(buffer, 0, length);
        }

        /// <summary>当前输入桌面的名字；打不开 / 读不到返回 null</summary>
        internal static string InputName()
        {
            IntPtr desktop = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
            if (desktop == IntPtr.Zero) return null;
            try
            {
                return NameOf(desktop);
            }
            finally
            {
                Native.CloseDesktop(desktop);
            }
        }

        /// <summary>本进程当前线程所在的桌面名（排查用：typist 应该在 Winlogon 上）</summary>
        internal static string ThreadName()
        {
            IntPtr desktop = Native.GetThreadDesktop(Native.GetCurrentThreadId());
            if (desktop == IntPtr.Zero) return null;
            return NameOf(desktop);
        }

        internal static bool IsDefault(string name)
        {
            return name != null && string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase);
        }

        internal static bool IsWinlogon(string name)
        {
            return name != null && string.Equals(name, "Winlogon", StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// 本进程所在会话的锁定状态：WTSQuerySessionInformationW(WTSSessionInfoEx) 里的 SessionFlags。
    /// 为什么需要：锁屏界面和 UAC 权限确认 / Ctrl+Alt+Del 这类安全桌面都在 Winlogon 桌面上，光看桌面名分不开；
    /// 而往 UAC 提示里输入开机密码再按回车，回车默认落在「是」上，等于替用户点了同意——所以只有明确读到「会话已锁定」才输入。
    /// 结构布局（32 / 64 位相同）：Level@0，SessionId@8，SessionState@12，SessionFlags@16；SessionFlags 0 = 已锁定，1 = 未锁定，0xFFFFFFFF = 未知
    /// （Windows 7 上含义是反的，不在支持范围内）。
    /// 读出来的内容对不上预期（Level 不是 1，或结构里的 SessionId 不等于本进程自己的会话号——偏移要是猜错了就会这样）一律按「未知」处理。
    /// </summary>
    internal static class SessionLock
    {
        internal const int Unknown = 0;
        internal const int Locked = 1;
        internal const int Unlocked = 2;

        const uint CurrentSession = 0xFFFFFFFF;
        const int InfoClassSessionInfoEx = 25;
        const int OffsetLevel = 0;
        const int OffsetSessionId = 8;
        const int OffsetFlags = 16;
        const int MinBytes = 20;

        internal static string Describe(int state)
        {
            if (state == Locked) return "locked";
            if (state == Unlocked) return "unlocked";
            return "unknown";
        }

        /// <summary>读本进程所在会话的锁定状态。永不抛；detail 给日志用（读不出来的原因，不含任何敏感内容）</summary>
        internal static int Read(out string detail)
        {
            detail = null;
            IntPtr buffer = IntPtr.Zero;
            try
            {
                uint mine;
                if (!Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out mine))
                {
                    detail = "读不到本进程的会话号（错误码 " + Marshal.GetLastWin32Error() + "）";
                    return Unknown;
                }
                uint bytes;
                if (!Native.WTSQuerySessionInformation(IntPtr.Zero, CurrentSession, InfoClassSessionInfoEx, out buffer, out bytes))
                {
                    detail = "WTSQuerySessionInformation 失败（错误码 " + Marshal.GetLastWin32Error() + "）";
                    buffer = IntPtr.Zero;
                    return Unknown;
                }
                if (buffer == IntPtr.Zero || bytes < MinBytes)
                {
                    detail = "返回的数据太短（" + bytes + " 字节）";
                    return Unknown;
                }
                int level = Marshal.ReadInt32(buffer, OffsetLevel);
                if (level != 1)
                {
                    detail = "Level=" + level;
                    return Unknown;
                }
                uint sessionId = unchecked((uint)Marshal.ReadInt32(buffer, OffsetSessionId));
                if (sessionId != mine)
                {
                    detail = "结构里的会话号 " + sessionId + " 和本进程的 " + mine + " 对不上";
                    return Unknown;
                }
                int flags = Marshal.ReadInt32(buffer, OffsetFlags);
                if (flags == 0) return Locked;
                if (flags == 1) return Unlocked;
                detail = "SessionFlags=" + flags;
                return Unknown;
            }
            catch (Exception ex)
            {
                detail = ex.GetType().Name;
                return Unknown;
            }
            finally
            {
                if (buffer != IntPtr.Zero) Native.WTSFreeMemory(buffer);
            }
        }
    }

    /// <summary>typist：在 winlogon 桌面上输入密码。退出码就是它给 service 的结果</summary>
    internal static class Typist
    {
        internal const int Unlocked = 0;
        internal const int NotLocked = 10;
        internal const int NoCredential = 11;
        internal const int NotTypeable = 12;
        internal const int DesktopError = 13;
        internal const int InputFailedEarly = 14;
        internal const int CredentialUnreadable = 15;
        /// <summary>输入桌面不是 Default，会话却没有锁定：这是 UAC 权限确认之类的安全桌面，一个键都不能按</summary>
        internal const int SecureDesktop = 16;
        // 20 及以上：密码已经（至少部分）输进去过，service 据此进入冷却
        internal const int StillLocked = 20;
        internal const int InputFailedMid = 21;
        internal const int Unexpected = 30;

        const byte VK_SHIFT = 0x10;
        const byte VK_RETURN = 0x0D;
        const byte VK_CAPITAL = 0x14;
        const int KeyGapMs = 25;
        const int WakeSettleMs = 1500;
        const int VerifyTimeoutMs = 9000;
        const int VerifyStepMs = 250;

        static bool SendKey(byte vk, bool up)
        {
            Native.INPUT[] inputs = new Native.INPUT[1];
            inputs[0].type = Native.INPUT_KEYBOARD;
            inputs[0].U.ki.wVk = vk;
            inputs[0].U.ki.wScan = (ushort)Native.MapVirtualKey(vk, 0);
            inputs[0].U.ki.dwFlags = up ? Native.KEYEVENTF_KEYUP : 0u;
            return Native.SendInput(1, inputs, Marshal.SizeOf(typeof(Native.INPUT))) == 1;
        }

        static bool MoveMouse(int dx)
        {
            Native.INPUT[] inputs = new Native.INPUT[1];
            inputs[0].type = Native.INPUT_MOUSE;
            inputs[0].U.mi.dx = dx;
            inputs[0].U.mi.dy = 0;
            inputs[0].U.mi.dwFlags = Native.MOUSEEVENTF_MOVE;
            return Native.SendInput(1, inputs, Marshal.SizeOf(typeof(Native.INPUT))) == 1;
        }

        static bool Tap(byte vk)
        {
            if (!SendKey(vk, false)) return false;
            Thread.Sleep(KeyGapMs);
            return SendKey(vk, true);
        }

        /// <summary>
        /// 输入桌面不是 Default 时，能不能往里输入：只有会话明确是「已锁定」才行。
        /// 锁屏界面和 UAC 权限确认等安全桌面都在 Winlogon 上，只有会话的锁定标志分得开；
        /// 往 UAC 里输密码再回车，回车默认按在「是」上，等于替用户点了同意——读不出来也不输。
        /// 返回 0 = 可以继续；否则是 typist 该直接返回的退出码。
        /// beforeWake：还没唤醒的第一次检查。屏保之类「不是 Winlogon、会话也没锁」的桌面放行去唤醒（唤醒会把屏保关掉，之后一次检查再放行 / 拒绝）；输入前最后一次检查则一律拒绝。
        /// </summary>
        static int CheckLockedForTyping(string runId, string inputDesktop, bool beforeWake)
        {
            string detail;
            int state = SessionLock.Read(out detail);
            string stage = beforeWake ? "唤醒前" : "输入前";
            if (state == SessionLock.Locked) return 0;
            if (state == SessionLock.Unknown)
            {
                Log.Write("error", "typist " + runId + " " + stage + "读不出会话是否锁定（" + (detail ?? "?") + "），为安全起见不输入");
                return DesktopError;
            }
            if (Desktops.IsWinlogon(inputDesktop))
            {
                Log.Write("warn", "typist " + runId + " " + stage + "会话没有锁定，输入桌面却是 Winlogon：这是 UAC 权限确认之类的安全提示，不输入");
                return SecureDesktop;
            }
            if (beforeWake) return 0;
            Log.Write("info", "typist " + runId + " " + stage + "会话没有锁定（输入桌面=" + inputDesktop + "），不输入");
            return NotLocked;
        }

        /// <summary>
        /// 按回车之前最后一次确认：输入桌面仍是锁屏（不是 Default，会话也仍是已锁定）。
        /// 输密码要几秒，这期间用户可能自己解开了锁（回车会落进他当前的窗口），也可能弹出了 UAC 之类的安全桌面（回车默认落在「是」上）。
        /// 读不出来一律当「不行」。返回 false 时调用方不按回车；密码已经（至少部分）输进去过，所以要按「输过」收场（进冷却）。
        /// </summary>
        static bool StillLockedBeforeSubmit(string runId)
        {
            string input = Desktops.InputName();
            if (input == null)
            {
                Log.Write("error", "typist " + runId + " 提交前读不到输入桌面，不按回车");
                return false;
            }
            if (Desktops.IsDefault(input))
            {
                Log.Write("warn", "typist " + runId + " 提交前输入桌面已经是 Default（用户可能自己解锁了），不按回车");
                return false;
            }
            return CheckLockedForTyping(runId, input, false) == 0;
        }

        internal static int Run(string[] args)
        {
            string runId = args.Length > 1 ? args[1] : "-";
            string threadDesktop = null;
            try
            {
                threadDesktop = Desktops.ThreadName();
            }
            catch
            {
                // 只是排查信息
            }
            Log.Write("info", "typist " + runId + " 启动，所在桌面=" + (threadDesktop ?? "?"));

            string input = Desktops.InputName();
            if (input == null)
            {
                Log.Write("error", "typist " + runId + " 读不到输入桌面（错误码 " + Marshal.GetLastWin32Error() + "）");
                return DesktopError;
            }
            if (Desktops.IsDefault(input))
            {
                Log.Write("info", "typist " + runId + " 输入桌面是 Default，电脑没有锁屏，不输入");
                return NotLocked;
            }
            // 输入桌面不是 Default：是锁屏，还是 UAC 权限确认之类的安全桌面？（见 CheckLockedForTyping）
            int gate = CheckLockedForTyping(runId, input, true);
            if (gate != 0) return gate;

            char[] password = null;
            bool typedAnything = false;
            try
            {
                try
                {
                    password = CredStore.Load();
                }
                catch (Exception ex)
                {
                    Log.Write("error", "typist " + runId + " 读不出保存的开机密码：" + ex.GetType().Name);
                    return CredentialUnreadable;
                }
                if (password == null) return NoCredential;
                if (!Keymap.IsTypeable(password)) return NotTypeable;

                // 叫醒锁屏界面：轻点一下 Shift + 鼠标微动（都是无害的输入），等界面进入「可输入」状态
                if (!Tap(VK_SHIFT) || !MoveMouse(1))
                {
                    Log.Write("error", "typist " + runId + " 唤醒输入失败（错误码 " + Marshal.GetLastWin32Error() + "）");
                    return InputFailedEarly;
                }
                Thread.Sleep(30);
                MoveMouse(-1);
                Thread.Sleep(WakeSettleMs);

                // 输入之前最后一次确认：这一秒多里用户可能已经自己解开了，那就一个键都不要再按
                input = Desktops.InputName();
                if (input == null) return DesktopError;
                if (Desktops.IsDefault(input))
                {
                    Log.Write("info", "typist " + runId + " 唤醒后输入桌面已经是 Default（用户可能自己解锁了），不输入");
                    return NotLocked;
                }
                // 唤醒这一秒多里弹出了 UAC 之类的安全桌面也不能输：只有会话明确还是锁定的才输入
                gate = CheckLockedForTyping(runId, input, false);
                if (gate != 0) return gate;

                // Caps Lock 开着的话字母大小写会反：先关掉
                bool capsWasOn = (Native.GetKeyState(VK_CAPITAL) & 1) != 0;
                if (capsWasOn)
                {
                    Log.Write("info", "typist " + runId + " 发现 Caps Lock 开着，先关掉再输入");
                    if (!Tap(VK_CAPITAL)) return InputFailedEarly;
                    Thread.Sleep(KeyGapMs);
                }

                for (int i = 0; i < password.Length; i++)
                {
                    Keymap.KeyStroke stroke;
                    if (!Keymap.TryGet(password[i], out stroke)) return typedAnything ? InputFailedMid : NotTypeable;
                    bool ok = true;
                    if (stroke.Shift) ok = SendKey(VK_SHIFT, false);
                    if (ok)
                    {
                        typedAnything = true;
                        Thread.Sleep(KeyGapMs / 2);
                        ok = SendKey(stroke.Vk, false);
                        Thread.Sleep(KeyGapMs / 2);
                        ok = SendKey(stroke.Vk, true) && ok;
                    }
                    if (stroke.Shift)
                    {
                        Thread.Sleep(KeyGapMs / 2);
                        SendKey(VK_SHIFT, true);
                    }
                    if (!ok)
                    {
                        Log.Write("error", "typist " + runId + " 输入中途失败（错误码 " + Marshal.GetLastWin32Error() + "）");
                        return typedAnything ? InputFailedMid : InputFailedEarly;
                    }
                    Thread.Sleep(KeyGapMs);
                }
                // 密码已经输完：后面的任何失败都算「试过一次」
                Array.Clear(password, 0, password.Length);
                password = null;

                Thread.Sleep(80);
                // 回车之前再确认一次还在锁屏上（输密码这几秒里可能被用户自己解开 / 弹出 UAC）：不是就不按回车。检查紧贴着回车，中间不再 Sleep
                if (!StillLockedBeforeSubmit(runId)) return InputFailedMid;
                if (!Tap(VK_RETURN))
                {
                    Log.Write("error", "typist " + runId + " 提交（回车）失败");
                    return InputFailedMid;
                }

                int waited = 0;
                while (waited < VerifyTimeoutMs)
                {
                    Thread.Sleep(VerifyStepMs);
                    waited += VerifyStepMs;
                    string now = Desktops.InputName();
                    if (Desktops.IsDefault(now))
                    {
                        Log.Write("info", "typist " + runId + " 完成：输入桌面已切回 Default，用时约 " + waited + "ms（提交后）");
                        return Unlocked;
                    }
                }
                Log.Write("warn", "typist " + runId + " 提交后 " + VerifyTimeoutMs + "ms 内输入桌面仍不是 Default");
                return StillLocked;
            }
            catch (Exception ex)
            {
                Log.Write("error", "typist " + runId + " 意外：" + ex.GetType().Name);
                return typedAnything ? Unexpected : InputFailedEarly;
            }
            finally
            {
                if (password != null) Array.Clear(password, 0, password.Length);
            }
        }
    }

    /// <summary>在控制台会话的 winlogon 桌面上以 SYSTEM 身份拉起 typist</summary>
    internal static class Launcher
    {
        internal const int ResultOk = 0;
        internal const int ResultNoConsole = 1;
        internal const int ResultLaunchFailed = 2;
        internal const int ResultTimeout = 3;

        /// <summary>
        /// 在 token 上启用一项特权。SYSTEM 的令牌里这些特权默认可能是「已有但未启用」，
        /// CreateProcessAsUser / SetTokenInformation(会话) 需要它们处于启用状态。返回是否真的启用了。
        /// </summary>
        static bool EnablePrivilege(IntPtr token, string name)
        {
            Native.LUID luid;
            if (!Native.LookupPrivilegeValue(null, name, out luid)) return false;
            Native.TOKEN_PRIVILEGES privileges = new Native.TOKEN_PRIVILEGES();
            privileges.PrivilegeCount = 1;
            privileges.Luid = luid;
            privileges.Attributes = Native.SE_PRIVILEGE_ENABLED;
            if (!Native.AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) return false;
            // AdjustTokenPrivileges 在「请求的特权令牌里没有」时也返回 TRUE，要看 LastError
            return Marshal.GetLastWin32Error() != Native.ERROR_NOT_ALL_ASSIGNED;
        }

        /// <summary>返回 ResultXxx；ResultOk 时 exitCode 是 typist 的退出码</summary>
        internal static int RunTypist(uint consoleSession, string runId, out uint exitCode, out string detail)
        {
            exitCode = 0;
            detail = null;
            if (consoleSession == 0xFFFFFFFF)
            {
                detail = "没有控制台会话";
                return ResultNoConsole;
            }
            string exe = Assembly.GetEntryAssembly().Location;
            IntPtr self = IntPtr.Zero;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out self))
                {
                    detail = "OpenProcessToken 失败（" + Marshal.GetLastWin32Error() + "）";
                    return ResultLaunchFailed;
                }
                // 特权没启用就启用（失败只记日志：真缺特权的话后面的调用会失败并带错误码）
                string[] needed = new string[] { "SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" };
                for (int i = 0; i < needed.Length; i++)
                {
                    if (!EnablePrivilege(self, needed[i])) Log.Write("warn", "没能启用特权 " + needed[i]);
                }
                if (!Native.DuplicateTokenEx(self, Native.MAXIMUM_ALLOWED, IntPtr.Zero, Native.SecurityImpersonation, Native.TokenPrimary, out token))
                {
                    detail = "DuplicateTokenEx 失败（" + Marshal.GetLastWin32Error() + "）";
                    return ResultLaunchFailed;
                }
                uint session = consoleSession;
                if (!Native.SetTokenInformation(token, Native.TokenSessionId, ref session, 4))
                {
                    detail = "SetTokenInformation 失败（" + Marshal.GetLastWin32Error() + "）";
                    return ResultLaunchFailed;
                }

                Native.STARTUPINFO startup = new Native.STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
                startup.lpDesktop = "winsta0\\winlogon";
                Native.PROCESS_INFORMATION info;
                string commandLine = "\"" + exe + "\" typist " + runId;
                if (!Native.CreateProcessAsUser(token, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, Native.CREATE_NO_WINDOW, IntPtr.Zero, Path.GetDirectoryName(exe), ref startup, out info))
                {
                    detail = "CreateProcessAsUser 失败（" + Marshal.GetLastWin32Error() + "）";
                    return ResultLaunchFailed;
                }
                try
                {
                    uint waited = Native.WaitForSingleObject(info.hProcess, (uint)Const.TypistTimeoutMs);
                    if (waited != Native.WAIT_OBJECT_0)
                    {
                        Native.TerminateProcess(info.hProcess, 98);
                        detail = "typist 超过 " + (Const.TypistTimeoutMs / 1000) + " 秒没有结束，已结束它";
                        return ResultTimeout;
                    }
                    if (!Native.GetExitCodeProcess(info.hProcess, out exitCode))
                    {
                        detail = "读不到 typist 的退出码（" + Marshal.GetLastWin32Error() + "）";
                        return ResultLaunchFailed;
                    }
                    return ResultOk;
                }
                finally
                {
                    Native.CloseHandle(info.hThread);
                    Native.CloseHandle(info.hProcess);
                }
            }
            finally
            {
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                if (self != IntPtr.Zero) Native.CloseHandle(self);
            }
        }
    }

    /// <summary>一条请求：verb + 字段</summary>
    internal sealed class Request
    {
        internal string Verb;
        internal Dictionary<string, string> Fields = new Dictionary<string, string>();

        internal static Request Parse(string line)
        {
            if (line == null) return null;
            string[] parts = line.TrimEnd('\r', '\n').Split('\t');
            if (parts.Length < 2 || parts[0] != Const.Tag) return null;
            Request request = new Request();
            request.Verb = parts[1];
            for (int i = 2; i < parts.Length; i++)
            {
                int eq = parts[i].IndexOf('=');
                if (eq <= 0) return null;
                try
                {
                    request.Fields[parts[i].Substring(0, eq)] = Uri.UnescapeDataString(parts[i].Substring(eq + 1));
                }
                catch (UriFormatException)
                {
                    return null;
                }
            }
            return request;
        }
    }

    /// <summary>service：命名管道服务端</summary>
    internal static class Service
    {
        const int MaxInstances = 8;
        static readonly object UnlockGate = new object();
        static string allowedSid;
        static string pipeName;

        static string ReadAllowedSid()
        {
            if (!File.Exists(Paths.Config)) throw new InvalidOperationException("缺少 config.txt");
            string sid = File.ReadAllText(Paths.Config).Trim();
            // 校验格式：不是合法 SID 会在这里抛异常，service 起不来（宁可不启动也不放行未知账户）
            new SecurityIdentifier(sid);
            return sid;
        }

        /// <summary>
        /// 创建一个管道实例。DACL：SYSTEM 完全控制；登记账户读写。
        /// 登记账户的 ACE 里要带 CreateNewInstance：管道上这一位和「写入（追加）」是同一个比特（0x4），
        /// 客户端用 GENERIC_WRITE 打开管道（Node 的 net.connect 就是）时会申请它，缺了会被拒绝或被降级成只读句柄。
        /// 别的账户什么权限都没有，连不上。
        /// 管道名每次启动随机；pipe.txt 在 service 启动时先删旧的、管道建好后再写新的，退出时也删。
        /// 已知边界（威胁模型）：CreateNewInstance 这一位同时意味着，登记账户下的进程也能抢先创建同名管道实例（管道名随机，但 pipe.txt 公开可读），
        /// 从而冒充服务端、截获 Flowship 通过管道发出的「保存开机密码」请求。接受它的理由：能这么做的进程已经跑在用户自己的账户里，本来就能读键盘 / 屏幕 / Flowship 的内存；
        /// 这个管道防的是别的账户和低权限沙箱，防不了同一账户下的恶意软件。docs/COMPUTER-USE.md 的「已知边界」写了同样的话。
        /// </summary>
        static NamedPipeServerStream CreateServer()
        {
            PipeSecurity security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(allowedSid), PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance | PipeAccessRights.Synchronize, AccessControlType.Allow));
            return new NamedPipeServerStream(pipeName, PipeDirection.InOut, MaxInstances, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security);
        }

        static void RemovePipeFile()
        {
            try
            {
                if (File.Exists(Paths.PipeFile)) File.Delete(Paths.PipeFile);
            }
            catch
            {
                // 删不掉就留着：下次启动会覆盖
            }
        }

        internal static int Run()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Global\\FlowshipUnlockHelperService", out createdNew))
            {
                if (!createdNew)
                {
                    Log.Write("warn", "service 已经有一个实例在运行，这个实例退出");
                    return 3;
                }
                // 先删上一次留下的 pipe.txt：service 没起来的这段时间里客户端读不到管道名，宁可报「组件没在运行」，
                // 也不要拿旧名字去连（旧名字谁都读得到，可能已经被别的进程占了）
                RemovePipeFile();
                try
                {
                    allowedSid = ReadAllowedSid();
                }
                catch (Exception ex)
                {
                    Log.Write("fatal", "读不到授权账户：" + ex.GetType().Name + " " + ex.Message);
                    return 4;
                }

                NamedPipeServerStream listening = null;
                for (int attempt = 0; attempt < 5 && listening == null; attempt++)
                {
                    pipeName = "FlowshipUnlock-" + Guid.NewGuid().ToString("N");
                    try
                    {
                        listening = CreateServer();
                    }
                    catch (Exception ex)
                    {
                        Log.Write("warn", "创建管道失败（第 " + (attempt + 1) + " 次）：" + ex.GetType().Name);
                    }
                }
                if (listening == null)
                {
                    Log.Write("fatal", "多次创建管道都失败，退出（计划任务会重新拉起）");
                    return 5;
                }
                try
                {
                    File.WriteAllText(Paths.PipeFile, pipeName, new UTF8Encoding(false));
                }
                catch (Exception ex)
                {
                    Log.Write("fatal", "写 pipe.txt 失败：" + ex.GetType().Name);
                    return 6;
                }
                Log.Write("info", "service 启动，版本 " + Const.Version + "，账户已登记，管道已就绪");

                try
                {
                    // 接受循环出错（创建新实例失败、WaitForConnection 抛错）只做三件事：丢掉坏的监听实例、拉长重试间隔、限制日志量——
                    // **从不据此退出服务**。退出 = 交给计划任务重启，而它最多重启 5 次，之后服务就一直停着（直到用户重启电脑 / 重装）；
                    // 登记账户下的进程只要占住 MaxInstances 个管道实例（连着不说话，或自己创建同名实例），创建新实例就会连续失败，
                    // 「失败 N 次就退出」会把这种占用变成永久停摆。不退出的话，占用一消失服务自己就恢复。
                    int consecutiveFailures = 0;
                    while (true)
                    {
                        try
                        {
                            if (listening == null) listening = CreateServer();
                            listening.WaitForConnection();
                            NamedPipeServerStream connected = listening;
                            listening = null;
                            // 先把这条连接交给工作线程、再去建下一个监听实例：实例被占满、建不出来时，已经连上的这个客户端照常被服务，不会被丢掉
                            Thread worker = new Thread(delegate() { HandleClient(connected); });
                            worker.IsBackground = true;
                            worker.Start();
                            consecutiveFailures = 0;
                            listening = CreateServer();
                        }
                        catch (Exception ex)
                        {
                            consecutiveFailures++;
                            // 同一种故障（比如实例被占满）会一直重复：只记开头几次，之后每 60 次记一条，别把日志刷满
                            if (consecutiveFailures <= 3 || consecutiveFailures % 60 == 0)
                            {
                                Log.Write("error", "接受连接 / 创建管道出错（连续第 " + consecutiveFailures + " 次）：" + ex.GetType().Name);
                            }
                            DisposeQuietly(listening);
                            listening = null;
                            Thread.Sleep(consecutiveFailures < 5 ? 200 : 1000);
                        }
                    }
                }
                finally
                {
                    RemovePipeFile();
                }
            }
        }

        static void DisposeQuietly(IDisposable resource)
        {
            try
            {
                if (resource != null) resource.Dispose();
            }
            catch
            {
                // 已经坏了的实例，释放失败也没什么可做的
            }
        }

        /// <summary>读一行（LF 结尾），最多 max 字节；对端关闭 / 超长返回 null</summary>
        static string ReadLine(Stream stream, int max)
        {
            List<byte> bytes = new List<byte>();
            while (bytes.Count <= max)
            {
                int b = stream.ReadByte();
                if (b < 0) return null;
                if (b == '\n') return Encoding.UTF8.GetString(bytes.ToArray());
                bytes.Add((byte)b);
            }
            return null;
        }

        static void Respond(Stream stream, bool ok, string code, params string[] keyValues)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(Const.Tag).Append('\t').Append(ok ? "ok" : "err").Append('\t').Append("code=").Append(code);
            for (int i = 0; i + 1 < keyValues.Length; i += 2)
            {
                sb.Append('\t').Append(keyValues[i]).Append('=').Append(Uri.EscapeDataString(keyValues[i + 1] ?? ""));
            }
            sb.Append('\n');
            byte[] data = new UTF8Encoding(false).GetBytes(sb.ToString());
            stream.Write(data, 0, data.Length);
            stream.Flush();
        }

        static void HandleClient(NamedPipeServerStream pipe)
        {
            System.Threading.Timer watchdog = null;
            try
            {
                // 防止客户端连上不说话 / 说一半：到时间直接把管道关掉
                watchdog = new System.Threading.Timer(delegate(object state)
                {
                    try
                    {
                        pipe.Dispose();
                    }
                    catch
                    {
                    }
                }, null, Const.ClientTimeoutMs, Timeout.Infinite);

                string line = ReadLine(pipe, Const.MaxLine);
                Request request = Request.Parse(line);
                if (request == null)
                {
                    Respond(pipe, false, "BAD_REQUEST");
                    return;
                }

                // 身份：管道 DACL 已经只放行登记的账户；这里再核对一遍（RunAsClient 必须在读过一次数据之后调用）
                string clientSid = null;
                try
                {
                    pipe.RunAsClient(delegate() { clientSid = WindowsIdentity.GetCurrent().User.Value; });
                }
                catch (Exception ex)
                {
                    Log.Write("warn", "读不到客户端身份：" + ex.GetType().Name);
                }
                if (clientSid == null || !string.Equals(clientSid, allowedSid, StringComparison.OrdinalIgnoreCase))
                {
                    Log.Write("warn", "拒绝了一个未登记账户的请求（verb=" + request.Verb + "）");
                    Respond(pipe, false, "DENIED");
                    return;
                }

                uint clientSession;
                if (!Native.GetNamedPipeClientSessionId(pipe.SafePipeHandle.DangerousGetHandle(), out clientSession)) clientSession = 0xFFFFFFFF;

                switch (request.Verb)
                {
                    case "ping":
                        Respond(pipe, true, "PONG", "proto", Const.Proto.ToString(CultureInfo.InvariantCulture), "ver", Const.Version.ToString(CultureInfo.InvariantCulture));
                        break;
                    case "status":
                        DoStatus(pipe, clientSession);
                        break;
                    case "set":
                        DoSet(pipe, request);
                        break;
                    case "clear":
                        DoClear(pipe);
                        break;
                    case "check":
                        DoCheck(pipe);
                        break;
                    case "unlock":
                        DoUnlock(pipe, clientSession);
                        break;
                    default:
                        Respond(pipe, false, "BAD_REQUEST");
                        break;
                }
                try
                {
                    pipe.WaitForPipeDrain();
                }
                catch
                {
                    // 客户端已经读完并关闭
                }
            }
            catch (Exception ex)
            {
                Log.Write("error", "处理请求出错：" + ex.GetType().Name);
                try
                {
                    Respond(pipe, false, "INTERNAL");
                }
                catch
                {
                }
            }
            finally
            {
                if (watchdog != null) watchdog.Dispose();
                try
                {
                    pipe.Dispose();
                }
                catch
                {
                }
            }
        }

        static void DoStatus(Stream pipe, uint clientSession)
        {
            TimeSpan left = Cooldown.Remaining();
            Respond(pipe, true, "OK",
                "proto", Const.Proto.ToString(CultureInfo.InvariantCulture),
                "ver", Const.Version.ToString(CultureInfo.InvariantCulture),
                "has", CredStore.Exists() ? "1" : "0",
                "cool", ((int)Math.Ceiling(left.TotalSeconds)).ToString(CultureInfo.InvariantCulture),
                "console", Native.WTSGetActiveConsoleSessionId().ToString(CultureInfo.InvariantCulture),
                "client", clientSession.ToString(CultureInfo.InvariantCulture));
        }

        static void DoSet(Stream pipe, Request request)
        {
            string value;
            if (!request.Fields.TryGetValue("pw", out value) || string.IsNullOrEmpty(value))
            {
                Respond(pipe, false, "BAD_REQUEST");
                return;
            }
            char[] password = value.ToCharArray();
            value = null;
            request.Fields.Remove("pw");
            try
            {
                if (!Keymap.IsTypeable(password))
                {
                    Respond(pipe, false, "NOT_TYPEABLE");
                    return;
                }
                try
                {
                    CredStore.Save(password);
                }
                catch (Exception ex)
                {
                    Log.Write("error", "保存开机密码失败：" + ex.GetType().Name);
                    Respond(pipe, false, "STORE_FAILED");
                    return;
                }
                // 用户重新保存了密码：之前的失败冷却不再有意义
                if (!Cooldown.Clear())
                {
                    // 密码已经存好了，但冷却记录清不掉（状态文件被占用 / 没权限）。清不掉不等于冷却还在生效：
                    // 记录可能只是一个早已过期的时间戳（Remaining 已经是 0），那样根本没有冷却在挡人，回「冷却没清掉」是误报（v3）。
                    int stillWait = Cooldown.StillBlockedSeconds();
                    if (stillWait > 0)
                    {
                        // 冷却确实还在：如实回报，别让用户以为已经恢复自动解锁——
                        // 回的是失败 + wait（还剩几秒）：密码本身没问题，等冷却结束（或排除文件被占用的原因后再保存一次）就能用
                        Log.Write("warn", "已保存开机密码，但冷却记录没能清除（还剩 " + stillWait + " 秒）");
                        Respond(pipe, false, "COOLDOWN_NOT_CLEARED", "saved", "1", "wait", stillWait.ToString(CultureInfo.InvariantCulture));
                        return;
                    }
                    // 冷却记录没清掉，但它已经过期：不影响使用，只记一条日志，照常回 OK（不记密码，不记 ex.Message）
                    Log.Write("warn", "冷却记录没清掉，但它已经过期，不影响使用");
                }
                Log.Write("info", "已保存开机密码（长度不记录）");
                Respond(pipe, true, "OK");
            }
            finally
            {
                Array.Clear(password, 0, password.Length);
            }
        }

        // 有意不设版本闸：用户即使装着旧版组件，也必须能删掉自己保存的开机密码。
        static void DoClear(Stream pipe)
        {
            try
            {
                CredStore.Delete();
            }
            catch (Exception ex)
            {
                Log.Write("error", "删除开机密码失败：" + ex.GetType().Name);
                Respond(pipe, false, "STORE_FAILED");
                return;
            }
            // 密码已经删掉了，冷却再也输不出任何东西；清不掉也只记日志（下一次保存密码时还会再清一次，并如实回报）
            if (!Cooldown.Clear()) Log.Write("warn", "已清除开机密码，但冷却记录没能清除（下一次保存密码时会再清一次）");
            Log.Write("info", "已清除开机密码");
            Respond(pipe, true, "OK");
        }

        static void DoCheck(Stream pipe)
        {
            if (!CredStore.Exists())
            {
                Respond(pipe, false, "NO_CREDENTIAL");
                return;
            }
            char[] password = null;
            try
            {
                password = CredStore.Load();
                if (password == null) Respond(pipe, false, "NO_CREDENTIAL");
                else if (!Keymap.IsTypeable(password)) Respond(pipe, false, "NOT_TYPEABLE");
                else Respond(pipe, true, "OK");
            }
            catch (Exception ex)
            {
                Log.Write("error", "校验开机密码时读不出来：" + ex.GetType().Name);
                Respond(pipe, false, "CRED_UNREADABLE");
            }
            finally
            {
                if (password != null) Array.Clear(password, 0, password.Length);
            }
        }

        static void DoUnlock(Stream pipe, uint clientSession)
        {
            uint console = Native.WTSGetActiveConsoleSessionId();
            if (console == 0xFFFFFFFF)
            {
                Respond(pipe, false, "NO_CONSOLE_SESSION", "attempted", "0");
                return;
            }
            if (clientSession != console)
            {
                // Flowship 不在本地控制台会话里（例如远程桌面）：这里输入的是控制台的锁屏界面，对不上
                Respond(pipe, false, "NOT_CONSOLE_CLIENT", "attempted", "0");
                return;
            }
            lock (UnlockGate)
            {
                TimeSpan left = Cooldown.Remaining();
                if (left > TimeSpan.Zero)
                {
                    Respond(pipe, false, "COOLDOWN", "attempted", "0", "wait", ((int)Math.Ceiling(left.TotalSeconds)).ToString(CultureInfo.InvariantCulture));
                    return;
                }
                if (!CredStore.Exists())
                {
                    Respond(pipe, false, "NO_CREDENTIAL", "attempted", "0");
                    return;
                }

                string runId = Guid.NewGuid().ToString("N").Substring(0, 8);
                Log.Write("info", "开始解锁 " + runId + "（控制台会话 " + console + "）");
                uint exitCode;
                string detail;
                int result = Launcher.RunTypist(console, runId, out exitCode, out detail);
                if (result == Launcher.ResultNoConsole)
                {
                    Respond(pipe, false, "NO_CONSOLE_SESSION", "attempted", "0");
                    return;
                }
                if (result == Launcher.ResultLaunchFailed)
                {
                    Log.Write("error", "解锁 " + runId + " 拉起 typist 失败：" + detail);
                    Respond(pipe, false, "LAUNCH_FAILED", "attempted", "0", "detail", detail ?? "");
                    return;
                }
                if (result == Launcher.ResultTimeout)
                {
                    // 不知道有没有输进去过：按「试过一次」处理，进入冷却
                    Cooldown.Start();
                    Log.Write("error", "解锁 " + runId + " 超时");
                    Respond(pipe, false, "TIMEOUT", "attempted", "1");
                    return;
                }

                Log.Write("info", "解锁 " + runId + " 结束，typist 退出码 " + exitCode);
                switch ((int)exitCode)
                {
                    case Typist.Unlocked:
                        // 能走到解锁说明进来时冷却早已过期（有冷却的话上面就挡回去了）：清不掉也不影响结果，Clear 自己已记过日志
                        Cooldown.Clear();
                        Respond(pipe, true, "UNLOCKED", "attempted", "1");
                        return;
                    case Typist.NotLocked:
                        Respond(pipe, false, "NOT_LOCKED", "attempted", "0");
                        return;
                    case Typist.SecureDesktop:
                        // 屏幕上是 UAC 之类的安全桌面：不是锁屏，什么都没输入，也不进冷却
                        Respond(pipe, false, "SECURE_DESKTOP", "attempted", "0");
                        return;
                    case Typist.NoCredential:
                        Respond(pipe, false, "NO_CREDENTIAL", "attempted", "0");
                        return;
                    case Typist.NotTypeable:
                        Respond(pipe, false, "NOT_TYPEABLE", "attempted", "0");
                        return;
                    case Typist.CredentialUnreadable:
                        Respond(pipe, false, "CRED_UNREADABLE", "attempted", "0");
                        return;
                    case Typist.DesktopError:
                        Respond(pipe, false, "DESKTOP_ERROR", "attempted", "0");
                        return;
                    case Typist.InputFailedEarly:
                        Respond(pipe, false, "INPUT_FAILED", "attempted", "0");
                        return;
                    case Typist.StillLocked:
                        Cooldown.Start();
                        Respond(pipe, false, "STILL_LOCKED", "attempted", "1");
                        return;
                    case Typist.InputFailedMid:
                        Cooldown.Start();
                        Respond(pipe, false, "INPUT_FAILED", "attempted", "1");
                        return;
                    case Typist.Unexpected:
                        Cooldown.Start();
                        Respond(pipe, false, "INTERNAL", "attempted", "1", "detail", "typist 退出码 " + exitCode);
                        return;
                    default:
                        // 不认识的退出码（崩溃 / 被结束）：密码有没有输进去不确定，保守起见也进冷却
                        Cooldown.Start();
                        Respond(pipe, false, "INTERNAL", "attempted", "1", "detail", "typist 退出码 " + exitCode);
                        return;
                }
            }
        }
    }

    /// <summary>安装器编译完之后跑一次：只做无副作用的检查，不碰真实凭据</summary>
    internal static class SelfTest
    {
        internal static int Run()
        {
            // 字符表：长度对得上，且典型字符都在
            Keymap.KeyStroke stroke;
            if (Keymap.KeyCount != 48 || !Keymap.TryGet('a', out stroke) || stroke.Vk != 0x41 || stroke.Shift) return 20;
            if (!Keymap.TryGet('A', out stroke) || stroke.Vk != 0x41 || !stroke.Shift) return 21;
            if (!Keymap.TryGet('!', out stroke) || stroke.Vk != 0x31 || !stroke.Shift) return 22;
            if (Keymap.TryGet('\u4e2d', out stroke)) return 23;

            // 数据保护可用（用一段随机数据来回加解密，不碰真实凭据）
            byte[] sample = new byte[16];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(sample);
            }
            byte[] entropy = Encoding.UTF8.GetBytes("Flowship.Unlock.selftest");
            byte[] roundTrip = ProtectedData.Unprotect(ProtectedData.Protect(sample, entropy, DataProtectionScope.LocalMachine), entropy, DataProtectionScope.LocalMachine);
            if (roundTrip.Length != sample.Length) return 24;
            for (int i = 0; i < sample.Length; i++)
            {
                if (roundTrip[i] != sample[i]) return 24;
            }

            // INPUT 结构大小和 Windows 的期望一致（64 位 40 字节，32 位 28 字节）：不一致 SendInput 会直接失败
            int expected = IntPtr.Size == 8 ? 40 : 28;
            if (Marshal.SizeOf(typeof(Native.INPUT)) != expected) return 25;

            // 系统 API 都能解析（只调用无副作用的）
            uint console = Native.WTSGetActiveConsoleSessionId();
            if (Native.GetCurrentProcess() == IntPtr.Zero) return 26;
            Native.MapVirtualKey(0x41, 0);
            Native.GetKeyState(0x14);

            // 「会话是否锁定」的读取：typist 靠它分清锁屏和 UAC 权限确认，读不出来就永远不敢输入（解锁永远不会成功）。
            // 自检结果不限已锁 / 未锁（装的过程中用户可能刚好锁屏走人），只要读得出来、内容对得上预期；未知 = 这台电脑上读不了，安装失败
            string lockDetail;
            int lockState = SessionLock.Read(out lockDetail);
            Log.Write("info", "selftest：会话锁定状态读取结果=" + SessionLock.Describe(lockState) + (lockDetail == null ? "" : "（" + lockDetail + "）"));
            if (lockState == SessionLock.Unknown) return 27;

            Log.Write("info", "selftest 通过（控制台会话 " + console + "）");
            return 0;
        }
    }

    internal static class Program
    {
        internal static int Main(string[] args)
        {
            string mode = args.Length > 0 ? args[0] : "";
            try
            {
                if (mode == "service") return Service.Run();
                if (mode == "typist") return Typist.Run(args);
                if (mode == "selftest") return SelfTest.Run();
                return 2;
            }
            catch (Exception ex)
            {
                Log.Write("fatal", mode + " 未处理的异常：" + ex.GetType().Name + " " + ex.Message);
                return 99;
            }
        }
    }
}
