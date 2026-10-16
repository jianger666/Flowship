/**
 * docx / xlsx（本质都是 zip）解析前的 zip bomb 防护，分两层：
 *
 * 1) assertSafeOfficeZip（同步、不解压）：只读中央目录（EOCD + central directory 头，纯字节解析），
 *    累加各条目**声明**的解压后大小，条目数 / 单条目 / 总量任一超限就拒绝。
 *    便宜（耗时与中央目录大小成正比），先把「老实声明」的炸弹与条目数爆炸挡在解压之前。
 *
 * 2) assertOfficeZipActualSizes（异步、真解压）：声明值是文件自己写的，构造者可以谎报成很小
 *    （N1-01）。所以对每个条目定位本地文件头 → 数据起点，用 zlib 的 `maxOutputLength` 真实解压，
 *    累计**实际**输出量；输出一超限 zlib 就提前抛 ERR_BUFFER_TOO_LARGE，炸弹根本不会被展开。
 *    解压结果只取长度、立刻丢弃，不会长期留在内存。
 *
 * 为什么要自己做：20MB 的压缩包（高压缩比的重复数据）能解压成数 GB，
 * 解析器（mammoth/jszip、xlsx）会把它们整个解到内存，直接拖垮本机 server。
 *
 * 与两个解析器的行为对齐（读过 xlsx 0.20.3 的 parse_zip / jszip 的 readLocalPart）：
 * - xlsx 对**每个**条目都从本地头算出的数据起点（偏移 + 30 + 本地文件名长 + 本地 extra 长）起 inflate 到
 *   流结束，既不按中央目录的 compSize 截断、也没有输出上限——所以这里同样从数据起点一路切到 buffer 末尾，
 *   让 inflate 自己在流结束处停，不信中央目录的 compSize；
 * - mammoth 用的 jszip 按中央目录的 compSize 截数据，它能解出的内容是我们这边输出的前缀，
 *   所以我们统计的实际输出量是它的上界。
 * - 加密条目：xlsx 看本地头 flags（0x2041）直接抛错、jszip 看中央目录 flags 抛错——两边看的位置不同，
 *   所以不能因为「标了加密」就跳过校验（只有一边会拒），一律照样解压校验；真加密的数据解不出来，
 *   按「含加密内部文件」拒绝，与两个解析器本来就不支持加密的结论一致。
 * - 压缩方式取自哪里（F2-01）：xlsx 取**本地头**、jszip 取**中央目录**。守卫的分支按中央目录走，
 *   所以 xlsx 路径上本地头与中央目录的方式不一致就按歧义拒绝；否则中央目录写 stored 的条目守卫只核对声明大小，
 *   而 xlsx 按本地头的 deflate 真去展开。docx（jszip）读的就是中央目录这一份，不受影响、不拒绝。
 * - 不认识的压缩方式（非 0 / 8）：两个解析器都不会展开它，无从校验真实大小，
 *   按中央目录声明值计入预算（同步守卫早就是这么算的），不额外拒绝。
 * - xlsx 的 inflate 不是 Node zlib：0.20.3 默认用 SheetJS 自带的纯 JS 实现（要显式 use_zlib 才换原生，Flowship 没调）。
 *   zlib 能完整解开的合法流两边输出一致（全零炸弹实测 JS 版吞吐 200~400MB/s，与 zlib 同量级）；
 *   而 zlib 失败的数据，纯 JS 版可能空转很久、没法预言，所以 zlib 失败一律拒绝。
 *   唯一曾被放行的口子是「压缩后 / 解压后都声明为 0 的空 deflate 条目」，xlsx 路径上也已收紧（docx 仍放行，细节见该分支注释）；
 * - 条目数以「本盘条目数」与「总条目数」两个字段是否一致作校验：xlsx 迭代的是前者、本守卫迭代后者，
 *   两个不一致的 zip 能让守卫只看见前几个条目而 xlsx 解开全部，直接按结构损坏拒绝。
 *
 * 集合一致性（第四轮审查 M3-01 / M3-02）：以上所有结论都建立在同一个前提上——**守卫看到的条目集合必须
 * 等于下游解析器看到的集合**，否则守卫检查的是 A、解析器展开的是 B，限额形同虚设。
 * tests/office-zip-guard-parser-parity.test.ts 用真实 jszip / xlsx 0.20.3 对拍，实测朴素守卫
 * （只按 EOCD 声明条数迭代）与两个解析器有下面这些分歧；统一按「歧义 → 拒绝」收口，不去复刻各家的怪癖：
 * - jszip 读中央目录**不看条数**，一路读到「不再是 PK\x01\x02」为止：EOCD 条数 5 改成 3，守卫只看前 3 条、
 *   jszip 读到全部 5 条（M3-01：60KB 的 zip 藏 60MB 的 document.xml）；
 * - jszip 发现 EOCD 之前多出 N 字节（中央目录与 EOCD 之间有间隙 / 前置垃圾）会把整个读取基准平移 N 字节
 *   （reader.zero），实际读的是平移后的另一份目录，而 xlsx 与朴素守卫按字面偏移读；
 * - jszip 与 xlsx 都从文件末尾 -4 处起、向前找**最后一个** EOCD 签名，且都不校验 comment 长度；
 *   朴素守卫从末尾 -22 处起找，于是 comment 里藏一个只有 16~20 字节的残缺 EOCD 就能让 xlsx 选中它、
 *   守卫选真 EOCD（M3-02 搜索起点，实测 xlsx 读到 [a,b,c]、守卫读到 [a,b]）；
 * - jszip 在盘号 / 盘内条数 / 条数 = 0xFFFF 或 大小 / 偏移 = 0xFFFFFFFF（共 6 个字段）任一成立时改读 zip64 记录，
 *   xlsx 则**完全不读 zip64 记录**、永远用字面值（M3-02 zip64 触发条件，两个方向都实测能错位）。
 * 因此：EOCD 取文件末尾向前的最后一个签名（三方一致，前面的签名不论是内嵌 zip 还是别的都没人会选）、
 * 且 comment 长度正好到文件末尾；EOCD 的 6 个字段都不能是 zip64 占位
 * （docx / xlsx 有 20MB 预览上限、条目数上限 1 万，真实文档用不到 EOCD 级 zip64，条目级 zip64 扩展字段不受影响）；
 * 中央目录必须正好是 [cdOffset, cdOffset+cdSize) 且**紧贴 EOCD**，声明的 N 条记录必须正好填满它。
 * 这样 jszip 的「连续读到尽头 / 平移」与 xlsx 的「按条数读」在同一份字节上读到的就是同一个集合。
 *
 * CPU / 事件循环：真实解压最多 MAX_OFFICE_ZIP_TOTAL_BYTES（100MB，单条 50MB）。zlib 解压吞吐在数百 MB/s
 * 量级（本机实测 50MB 全零的单条约几十毫秒），守卫最坏也就是亚秒级 CPU。用的是**异步**
 * zlib.inflateRaw（在 libuv 线程池里跑），事件循环不被阻塞，所以不需要再在条目间手动 await 让出；
 * 条目之间顺序执行（预算依赖前面的累计结果），同一时刻最多占一个线程池线程。
 * 后面解析器（xlsx 的同步 XLSX.read）还会再解一遍，约 2 倍 CPU，同样被这两个上限框住。
 *
 * 重叠条目（多个中央目录条目指向同一段炸弹数据）也无法绕过：预算按每个条目的真实输出累计。
 */

import zlib from "node:zlib";

/** 条目数上限：正常 docx / xlsx 通常几十个条目，1 万已远超正常文档 */
export const MAX_OFFICE_ZIP_ENTRIES = 10_000;
/** 单个条目解压后上限（一张 document.xml / sheet1.xml / 内嵌图） */
export const MAX_OFFICE_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
/** 全部条目解压后总量上限 */
export const MAX_OFFICE_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;

/** EOCD 签名 PK\x05\x06 的字节形式（给 Buffer.lastIndexOf 用，C++ 实现的扫描比 JS 逐字节循环快得多） */
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_LOCAL_HEADER = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_EOCD_COMMENT = 0xffff;
const LOCAL_HEADER_SIZE = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** 加密相关 flags 位（bit0 加密 / bit6 强加密 / bit13 头部掩码），与 xlsx 的 `flags & 0x2041` 同口径 */
const FLAG_ENCRYPTED_MASK = 0x2041;

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);

const malformed = (): Error =>
  new Error("压缩包结构损坏或不是有效的 Office 文档，无法预览");

/** 结构本身能读，但不同解析器会读出不同内容（见文件头「集合一致性」）：不去猜哪个对，一律拒绝 */
const ambiguous = (detail: string): Error =>
  new Error(`压缩包目录结构有歧义（${detail}），不同解析器可能读到不同内容，已拒绝预览`);

/**
 * 定位 EOCD，并确认它是**没有歧义**的那一个。
 * 1) 从文件末尾 -4 处起向前找最后一个签名——与 jszip（lastIndexOfSignature）/ xlsx（blob.length - 4 起）
 *    的起点、方向完全一致；旧版从 -22 起找，漏掉末尾 4~21 字节内的残缺 EOCD，那正是 xlsx 会选中的那个；
 * 2) comment 长度必须正好把 EOCD 延伸到文件末尾：前置数据 / 尾随垃圾 / 谎报 comment 长度，
 *    都会让「选最后一个签名」「选 comment 能对齐的那个」这两类解析器各选各的；
 * 3) 不再因「窗口内出现第二个 EOCD 签名」拒绝（F2-02）。三个解析器（本守卫 / xlsx / jszip）都取**最后一个**签名，
 *    排在它前面的签名没人会选——比如 stored 的内嵌 zip（docx 里嵌入的 xlsx 图表数据）会在数据区里留下完整的
 *    EOCD 签名，小文件里它必然落在末尾窗口内，旧规则会把这类合法文档整份误杀，却没有任何安全收益。
 *    「各选各的」的歧义已由上面两条（起点 / 方向一致 + comment 对齐文件末尾）与后面的目录校验兜住：
 *    被选中的那个 EOCD 若自己不自洽，下面的目录紧贴 / 条数校验照样拒绝。窗口外的签名没有任何解析器会选
 *    （comment 最长 65535），不管。
 */
const findEocd = (buf: Buffer): number => {
  const windowStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_EOCD_COMMENT);
  const window = buf.subarray(windowStart);
  const rel = window.lastIndexOf(EOCD_SIGNATURE);
  if (rel < 0) throw malformed();
  const eocd = windowStart + rel;
  if (eocd + EOCD_MIN_SIZE > buf.length) throw malformed(); // 文件末尾的残缺 EOCD（装不下 22 字节固定部分）
  if (eocd + EOCD_MIN_SIZE + buf.readUInt16LE(eocd + 20) !== buf.length) {
    throw ambiguous("EOCD 的 comment 长度与文件实际末尾对不上");
  }
  return eocd;
};

const toSafeNumber = (v: bigint): number => {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed();
  return Number(v);
};

/** 中央目录里一个条目的校验用字段（zip64 扩展字段已展开） */
interface CentralEntry {
  /** 条目名（仅供对拍测试 / 诊断比较「守卫看到的集合」，守卫自身的校验不依赖它） */
  name: string;
  method: number;
  flags: number;
  /** 声明的解压后大小 */
  declaredSize: number;
  /** 声明的压缩后大小；zip64 占位却找不到扩展字段时为 -1 */
  compressedSize: number;
  /** 本地文件头偏移；同上，找不到为 -1 */
  localOffset: number;
}

/**
 * 遍历中央目录，对每个条目回调。EOCD / zip64 / 条目数上限 / 目录越界等结构校验都在这里，
 * 两层守卫共用同一份解析，避免「同步看一遍、真解压又按另一套口径看一遍」。
 * 回调里抛错即终止（同步守卫在回调里按声明值做限额判断）。
 */
const walkCentralDirectory = (
  buf: Buffer,
  label: string,
  onEntry: (entry: CentralEntry) => void,
): void => {
  const eocd = findEocd(buf);

  const diskNumber = buf.readUInt16LE(eocd + 4);
  const diskWithCentralDir = buf.readUInt16LE(eocd + 6);
  const entryCountThisDisk = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // EOCD 级 zip64：jszip 在这 6 个字段任一为占位值时改读 zip64 记录，xlsx 则永远只用字面值，
  // 同一个文件两个解析器必然看到不同的目录（实测两个方向都能错位）。真实 Office 文档用不到它，直接拒绝，
  // 不在这里复刻 jszip 的 zip64 定位逻辑（它搜 locator / zip64 EOCD 的方式本身也有歧义）
  if (
    diskNumber === 0xffff ||
    diskWithCentralDir === 0xffff ||
    entryCountThisDisk === 0xffff ||
    entryCount === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw ambiguous("EOCD 使用了 zip64 占位值，jszip 与 xlsx 对它的处理不一致");
  }

  // 单盘 zip 的「本盘条目数」必须等于「总条目数」。xlsx 按前者迭代、本守卫按后者，
  // 两者不一致就是在让两个解析器看到不同的目录（守卫只检查前几个、xlsx 解开全部）
  if (entryCountThisDisk !== entryCount) throw malformed();

  if (entryCount > MAX_OFFICE_ZIP_ENTRIES) {
    throw new Error(
      `${label} 内部文件数过多（${entryCount} > ${MAX_OFFICE_ZIP_ENTRIES}），疑似恶意压缩包，已拒绝预览`,
    );
  }

  // 中央目录必须紧贴 EOCD：jszip 用「EOCD 位置 - cdOffset - cdSize」算出多出的字节数、把整个读取基准平移，
  // 目录与 EOCD 之间有任何间隙（含前置垃圾、第二份目录）它读到的就是平移后的另一份；
  // 同时它读记录不看条数、一直读到签名不对为止，紧贴 EOCD 才保证它也恰好在这里停下
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocd) throw malformed(); // 目录越界（含被截断的文件）
  if (cdEnd < eocd) {
    throw ambiguous("中央目录没有紧贴 EOCD，其间还有多余字节 / 记录，或文件前面有垫的数据");
  }

  let pos = cdOffset;
  const end = cdEnd;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > end || buf.readUInt32LE(pos) !== SIG_CENTRAL_HEADER) {
      throw malformed();
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    let compressed = buf.readUInt32LE(pos + 20);
    let uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    let localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw malformed();

    // ZIP64：被填成 0xFFFFFFFF 的字段，真实值在扩展字段（id 0x0001）里，
    // 按 uncompressed、compressed、本地头偏移的顺序、只放被占位的项（所以 uncompressed 永远排第一）
    if (uncompressed === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff) {
      let z64Start = -1;
      let z64End = -1;
      let p = pos + 46 + nameLen;
      const extraEnd = p + extraLen;
      while (p + 4 <= extraEnd) {
        const id = buf.readUInt16LE(p);
        const len = buf.readUInt16LE(p + 2);
        if (id === 0x0001) {
          z64Start = p + 4;
          z64End = Math.min(p + 4 + len, extraEnd);
          break;
        }
        p += 4 + len;
      }
      let q = z64Start;
      // 依次取下一个 8 字节值；扩展字段缺失 / 不够长返回 null
      const takeZip64 = (): number | null => {
        if (z64Start < 0 || q + 8 > z64End) return null;
        const v = toSafeNumber(buf.readBigUInt64LE(q));
        q += 8;
        return v;
      };
      if (uncompressed === 0xffffffff) {
        const v = takeZip64();
        if (v === null) throw malformed();
        uncompressed = v;
      }
      if (compressed === 0xffffffff) compressed = takeZip64() ?? -1;
      if (localOffset === 0xffffffff) localOffset = takeZip64() ?? -1;
    }

    onEntry({
      name: buf.toString("utf8", pos + 46, pos + 46 + nameLen),
      method,
      flags,
      declaredSize: uncompressed,
      compressedSize: compressed,
      localOffset,
    });
    pos = next;
  }

  // 声明的 N 条必须**正好**读完中央目录（M3-01）。jszip 读记录不看条数、一路读到签名不对为止，
  // 若 N 条之后还有多余的 PK\x01\x02 记录，它会比守卫多读（审查者：60KB zip 里 60MB 的 document.xml，
  // EOCD 条数 5 改 3，守卫只看前 3 条、jszip 读到全部 5 条）。cdEnd 已确认紧贴 EOCD，
  // 所以 pos === cdEnd 同时保证了 jszip 在同一个位置停下
  if (pos !== cdEnd) {
    throw ambiguous("声明的条目数没有正好读完中央目录，其后还有多余记录或字节");
  }
};

/**
 * 第一层：按中央目录**声明**的大小校验；不安全 / 损坏则抛带可读中文的 Error。
 * 声明值可以被谎报，所以只是前置的廉价过滤，真正的防线是 assertOfficeZipActualSizes。
 * @param label 用于错误文案，如 "docx" / "xlsx"
 */
export const assertSafeOfficeZip = (buf: Buffer, label: string): void => {
  let total = 0;
  walkCentralDirectory(buf, label, ({ declaredSize }) => {
    if (declaredSize > MAX_OFFICE_ZIP_ENTRY_BYTES) {
      throw new Error(
        `${label} 内含解压后 ${mb(declaredSize)}MB 的单个文件（上限 ${mb(MAX_OFFICE_ZIP_ENTRY_BYTES)}MB），疑似压缩炸弹，已拒绝预览`,
      );
    }
    total += declaredSize;
    if (total > MAX_OFFICE_ZIP_TOTAL_BYTES) {
      throw new Error(
        `${label} 解压后总量超过 ${mb(MAX_OFFICE_ZIP_TOTAL_BYTES)}MB，疑似压缩炸弹，已拒绝预览`,
      );
    }
  });
};

/**
 * 守卫「看到的」条目名列表（按中央目录顺序）。只给对拍测试 / 诊断用：
 * 守卫的安全性取决于它看到的条目集合是否等于下游解析器（jszip / xlsx）看到的集合，
 * 测试需要把这两边直接拿出来比较。结构不合法同样抛 malformed。
 */
export const listOfficeZipEntryNames = (buf: Buffer, label = "zip"): string[] => {
  const names: string[] = [];
  walkCentralDirectory(buf, label, ({ name }) => names.push(name));
  return names;
};

const entryTooLarge = (label: string): Error =>
  new Error(
    `${label} 内含实际解压后超过 ${mb(MAX_OFFICE_ZIP_ENTRY_BYTES)}MB 的单个文件（按真实解压量统计，上限 ${mb(MAX_OFFICE_ZIP_ENTRY_BYTES)}MB），疑似压缩炸弹，已拒绝预览`,
  );

const totalTooLarge = (label: string): Error =>
  new Error(
    `${label} 实际解压后总量超过 ${mb(MAX_OFFICE_ZIP_TOTAL_BYTES)}MB（按真实解压量统计），疑似压缩炸弹，已拒绝预览`,
  );

const headerMismatch = (label: string): Error =>
  new Error(`${label} 内部文件头部与中央目录对不上，压缩包结构损坏，无法预览`);

const corruptedEntry = (label: string): Error =>
  new Error(`${label} 内部文件数据损坏，无法预览`);

/** 下游解析器是 SheetJS xlsx（预览路径用 "xlsx" 作 label，接线契约测试钉住了这一点） */
const XLSX_LABEL = "xlsx";

const emptyDeflateEntryForXlsx = (label: string): Error =>
  new Error(`${label} 内含没有压缩数据的空 deflate 条目，解析器处理它会长时间空转，已拒绝预览`);

const encryptedEntry = (label: string): Error =>
  new Error(`${label} 内含加密的内部文件，无法预览`);

/**
 * 定位条目数据起点：本地头签名 0x04034b50，文件名长 @26、extra 长 @28，
 * 数据起点 = 偏移 + 30 + 文件名长 + extra 长（用**本地头**自己的长度，与 xlsx / jszip 一致）。
 * 头部对不上（偏移越界 / 签名不对 / 数据起点超出文件）→ 拒绝。
 * 顺带返回本地头的压缩方式（@8）：xlsx 用它而不是中央目录的方式决定怎么读（F2-01，见调用处）。
 */
const locateEntryData = (
  buf: Buffer,
  entry: CentralEntry,
  label: string,
): { dataStart: number; localFlags: number; localMethod: number } => {
  const off = entry.localOffset;
  if (
    off < 0 ||
    off + LOCAL_HEADER_SIZE > buf.length ||
    buf.readUInt32LE(off) !== SIG_LOCAL_HEADER
  ) {
    throw headerMismatch(label);
  }
  const dataStart =
    off + LOCAL_HEADER_SIZE + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  if (dataStart > buf.length) throw headerMismatch(label);
  return {
    dataStart,
    localFlags: buf.readUInt16LE(off + 6),
    localMethod: buf.readUInt16LE(off + 8),
  };
};

/**
 * 真实解压并返回输出字节数（内容立刻丢弃）。
 * maxOutputLength 让 zlib 在输出越界时提前抛 ERR_BUFFER_TOO_LARGE、不继续展开；
 * data 一路切到 buffer 末尾，由 inflate 在流结束处自己停（流结束后的多余字节被忽略）。
 * 通过 `zlib.inflateRaw` 属性在调用时取用（不在模块加载时解构），便于测试里打桩观察传入的上限。
 */
const inflateActualSize = (data: Buffer, maxOutputLength: number): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    zlib.inflateRaw(data, { maxOutputLength }, (err, out) => {
      if (err) reject(err);
      else resolve(out.length);
    });
  });

/**
 * 第二层：真实解压校验（N1-01）。对每个条目累计**实际**输出量，按「单条 / 总量」两个预算拒绝，
 * 数据损坏 / 头部对不上 / 加密同样给出明确理由。声明大小与实际不符本身不拒绝——
 * 只要真实输出在预算内，解析器能展开的内容就没有超出我们愿意承担的规模。
 */
export const assertOfficeZipActualSizes = async (
  buf: Buffer,
  label: string,
): Promise<void> => {
  const entries: CentralEntry[] = [];
  walkCentralDirectory(buf, label, (entry) => entries.push(entry));

  // 已累计的真实总输出量
  let total = 0;
  for (const entry of entries) {
    const { dataStart, localFlags, localMethod } = locateEntryData(buf, entry, label);
    let actual: number;

    // F2-01：下游两个解析器取压缩方式的位置不同——jszip（docx）只看中央目录，本地头里的方式被忽略；
    // xlsx 的 parse_local_file 却只看**本地头**（meth = 本地头 @8），中央目录里的方式它根本不读。
    // 守卫下面的分支是按中央目录的方式走的：中央目录写 stored 时只核对声明大小、不展开，
    // 而本地头若写 deflate，xlsx 就会真去 inflate，且本地头的 usize 填 0 时（配 flags bit3 / data descriptor）
    // 输出缓冲不受任何声明约束——声明大小与实际展开量彻底脱钩，上面的预算形同虚设。
    // 反方向（中央目录 deflate / 本地头 stored）与「中央目录是不认识的方式、本地头是 deflate」同理：
    // 守卫看到的内容就不是 xlsx 读到的那份。不去复刻 xlsx 的每种读法，统一按歧义拒绝。
    // 只对 xlsx 路径拒绝：docx 走 jszip，它读的方式就是中央目录这一份，与守卫看到的一致，没有这个口子，
    // 真实写入器的本地头与中央目录方式也必然一致，不对 docx 多加一道会误伤的限制。
    if (label === XLSX_LABEL && localMethod !== entry.method) {
      throw ambiguous(
        `条目的本地头压缩方式 ${localMethod} 与中央目录的 ${entry.method} 不一致，xlsx 只看本地头、守卫按中央目录判断`,
      );
    }

    if (entry.method === METHOD_STORED) {
      // 存储方式不压缩：真实长度就是压缩后长度，既不可能膨胀、也不可能超出文件本身；
      // 对照声明值，不一致 / 数据被截断就是头部对不上
      actual = entry.compressedSize;
      if (
        actual < 0 ||
        dataStart + actual > buf.length ||
        actual !== entry.declaredSize
      ) {
        throw headerMismatch(label);
      }
    } else if (entry.method === METHOD_DEFLATE) {
      // 本条可用预算 = 单条上限与剩余总预算中较小者（zlib 要求 maxOutputLength ≥ 1，
      // 预算耗尽时取 1，下面累计后再按总量判一次，保证恰好用满总预算后任何非空条目都被拒绝）
      const remaining = MAX_OFFICE_ZIP_TOTAL_BYTES - total;
      const limit = Math.max(1, Math.min(MAX_OFFICE_ZIP_ENTRY_BYTES, remaining));
      try {
        actual = await inflateActualSize(buf.subarray(dataStart), limit);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw remaining < MAX_OFFICE_ZIP_ENTRY_BYTES
            ? totalTooLarge(label)
            : entryTooLarge(label);
        }
        // 压缩后 / 解压后大小都声明为 0 的空条目：有的写入器对空文件不写任何 deflate 数据，
        // 数据起点后面是下一个本地头，zlib 解不出东西但不是损坏；真有数据则上面已成功解压并被计入预算。
        if (entry.compressedSize === 0 && entry.declaredSize === 0) {
          // docx（jszip）按中央目录的 compSize=0 截出空数据、惰性解压，读到空内容，不会在它上面耗时，照旧放行。
          // xlsx 不行：它用的是 SheetJS 自带的纯 JS inflate（0.20.3 默认不启用原生 zlib，Flowship 也没调 use_zlib），
          // 且不看 compSize，而是从数据起点一路喂到文件末尾。zlib 在这段字节上失败，就说明里面没有终止块；
          // 纯 JS 版此时越界读到 undefined 当 0 位，解释成「长度 0 的 stored 块」永远等不到 final 块，
          // 空转到 32 位位偏移回绕才碰运气停下。实测一个 235 字节的 xlsx 就让 XLSX.read 同步阻塞约 1~3 秒，
          // 每个这样的条目叠加一次（8 个条目 907 字节 ≈ 12 秒），条目数上限 1 万——能把整个 server 的事件循环卡死。
          // 守卫的 zlib 判定与 xlsx 的 inflate 不是同一份实现，对 zlib 拒绝的数据没法预言 xlsx 会怎样，只能拒绝。
          // 真实写入器对空文件用 stored（本机 51 个真实 docx/xlsx、917 个 deflate 条目里没有一个 csize=0 的）。
          if (label === XLSX_LABEL) throw emptyDeflateEntryForXlsx(label);
          actual = 0;
        } else if (((entry.flags | localFlags) & FLAG_ENCRYPTED_MASK) !== 0) {
          throw encryptedEntry(label);
        } else {
          throw corruptedEntry(label);
        }
      }
    } else {
      // 其它压缩方式：两个解析器都不会展开，按声明值计入预算（见文件头注释）
      actual = entry.declaredSize;
    }

    total += actual;
    if (total > MAX_OFFICE_ZIP_TOTAL_BYTES) throw totalTooLarge(label);
  }
};

/**
 * 解析前的完整 zip 守卫：先按声明值廉价过滤，再真实解压校验。
 * docx / xlsx 预览路径统一调这个（不要只调同步的 assertSafeOfficeZip——它挡不住谎报）。
 */
export const assertSafeOfficeZipDeep = async (
  buf: Buffer,
  label: string,
): Promise<void> => {
  assertSafeOfficeZip(buf, label);
  await assertOfficeZipActualSizes(buf, label);
};

/** 是否以 zip 本地文件头 / 空 zip 魔数开头（xlsx 也可能是旧版 .xls 的 CFB，不是 zip） */
export const looksLikeZip = (buf: Buffer): boolean =>
  buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] < 0x20 && buf[3] < 0x20;

/**
 * 给异步解析加软超时：到点先 reject（调用方给用户可读错误），但**无法中断**底层仍在跑的解析。
 * 超时后底层 promise 的结果 / 异常被吞掉，避免 unhandled rejection。
 */
export const withSoftTimeout = <T>(
  work: Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
