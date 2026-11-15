# 可移植的 MetaMaker 客户端契约

业务代码继续使用 `@timemachine/generated-api`。本包保存当前 Web 实际依赖的原始生成产物与 `vi` 支持代码；安装、类型检查和构建不需要邻接 DPlanet、Unity 或 Unity Editor。

## 来源与边界

- `src/index.ts` 是手写的稳定导出入口，`src/snapshot/` 是同源文件的依赖闭包。后者不得手工改写、格式化或补 DTO。
- `source-manifest.json` 记录源仓库 HEAD、分支、每个源文件的工作区状态、字节数和 SHA-256。快照包含源工作区的未提交和未跟踪产物，不能用该 HEAD 的 `git archive` 代替。
- 本次闭包为 61 个导出根、121 个源文件：115 个 `code_ex` 生成文件和 6 个 `vi` 支持文件。仅有 `@timemachine/api-client` 这一项源闭包外部依赖。
- `code_ex` 的源头是 DPlanet 的 MetaMaker 产物，定义目录为 `MetaMaker2/Define`。源文件标识了生成器名称，但没有可证明整批生成所用的独立生成器版本；不能把某个文件的生成日期当成全批次版本。
- 当前固定的是已存在产物的原始字节。没有在本次任务运行完整 MetaMaker 定义生成流程，也没有证明它能从 HEAD 重建含 dirty 内容的全部产物。
- 用户授权的应用迁移覆盖本项目内部复用；本包不据此声明 DPlanet 源码具备独立对外再分发许可。CryptoJS 自带 MIT 许可由 npm 依赖保留。

## 安装与本地校验

从 Web 仓库根目录执行；本包是 npm workspace，不单独运行安装：

```bash
npm ci
node scripts/sync-generated-api.mjs --check
npx tsc --noEmit
npm test -- src/test/generated-api-portability.test.ts src/test/api-client.test.ts src/test/cloud-client-session.test.ts src/test/platform-runtime.test.ts src/test/shared-plate-client.test.ts src/test/shared-plate-byte-stream.test.ts src/test/shared-plate-adapter.test.ts src/test/shared-plate-catalog.test.ts
npm run build
```

`--check` 只读本仓库，检查导出根、文件集合、字节哈希、依赖闭包及聚合摘要；不寻找 DPlanet。测试还通过真正的 Vite 模块解析拒绝邻接源码目录，覆盖登录入口和 SDK，并检查密码摘要兼容性。

生产构建成功只证明代码与安装便携。轻量样本的页面入口、云初始化解耦和无服务运行验收属于 P1-07 与 P1-06 的集成门；在浏览器证据齐备前，不把包测试视作本地应用已可用。真实服务联调另行验证，默认关闭 live ingest 写入验收。

## 更新受控快照

1. 在源项目按其真实 MetaMaker 流程更新规范定义及生成产物；本脚本不代替 MetaMaker，也不修改源仓库。
2. 如新增 Web 消费契约，在 `src/index.ts` 增加指向 `./snapshot/` 的真实产物导出，不手写同名 DTO。
3. 将下面的占位目录替换为已核实的 DPlanet TypeScript 源目录，从 Web 仓库根目录运行：

```bash
node scripts/sync-generated-api.mjs --source-root "/absolute/path/to/DPlanet/TypeScript/src"
node scripts/sync-generated-api.mjs --check
```

4. 审查 `source-manifest.json` 与生成物差异，确认原协议字段、路径和序列化未改变，再重跑上述契约与集成测试。生产项目的协议变更需要单独授权，不能借便携迁移顺手实施。

脚本从当前导出根计算相对导入闭包，复制原始 Buffer，保留 BOM 和换行；不复制整个应用。遇到未批准的外部依赖、越界路径或疑似嵌入服务地址/凭据时停止并只报告文件名。它不自动删除旧文件；若源闭包缩小，先审查并按仓库删除规则处理旧快照。当前解析器针对已审查的 MetaMaker 静态 `from` 导入形式；生成器输出语法改变时应先审查脚本与隔离构建测试，不能假定任何 TypeScript 均可处理。

登录摘要源文件另设审核门：若 `utils/encrypt.ts` 的字节哈希不同于已有清单，脚本在写入前停止。先审查源语义、必要的适配器变更和独立 golden；经该协议变更授权后，才显式更新清单的 `accountDigestAdapter.sourceSha256` 为已审核源哈希并重新同步。不能只运行同步脚本就把新源哈希当作兼容性证明。

完整 `npm test` 还包含原有 WGP 重数据格式验收，需要既有 `data/generated/points/manifest.json` 及其七个 `.wgp` 样本；它们被 Git 忽略。纯 Git 文件集安装、编译成功不表示这些测试数据已准备齐全。本次独立副本记录了单独的样本来源与哈希，未跳过或缩减这些断言；轻量样本与重数据验收入口的分离留在便携启动集成工作中处理。

聚合摘要按源相对路径的字典序，对每行 `sha256`、两个空格、源相对路径、LF 拼接后的 UTF-8 内容计算 SHA-256。重复同步相同源工作区应得到相同快照和清单。

## 登录摘要适配

`src/account-password.ts` 是小型手写协议适配器，不是生成 DTO。其原始函数来源路径和源文件 SHA-256 记录在清单中；只迁移实际使用的 SHA-256 功能，不复制未使用的 MD5。

- 输入仍为账号、密码与既有公开协议后缀拼接，UTF-8 编码后计算 SHA-256，输出小写十六进制；公开后缀不是凭据。
- 优先使用浏览器 Web Crypto。普通 HTTP 调试等缺少 `crypto.subtle` 的环境按需加载 `crypto-js/sha256`，保持原有支持范围。
- 保留 CryptoJS 对孤立 UTF-16 代理项的拒绝语义，避免 `TextEncoder` 静默替换字符产生不同摘要。
- 函数继续返回 Promise，已有登录调用继续 await；不改变请求字段、鉴权头或服务端协议。
- 回退依赖精确锁定为源应用已安装的 `crypto-js@4.2.0`，类型为 `@types/crypto-js@4.2.2`。该库已宣布停止维护，因此只保留必要的兼容回退，未将其整包放入首屏入口。

摘要测试使用合成输入和 Node 独立 SHA-256 oracle，覆盖 ASCII、中文/emoji、空白/NUL、空字符串、非法代理项，以及有/无 Web Crypto 两条路径；构建测试验证 CryptoJS 位于动态分块，且未引入 MD5。
