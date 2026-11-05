# 纸间 · 小说听读器

为私下分享小说而做的手机网页应用，优先适配 iPhone Safari，也支持电脑及安卓浏览器。网站可以免费部署到公网，日常使用不需要作者的电脑常开。妈妈收到听书包后在自己的 iPhone 导入，小说、音频和进度保存在手机本地。

## 已实现

- 导入 `.md` / `.markdown` / `.txt` / Word `.docx`，可批量导入；单个文件上限 20 MB。
- 预生成双音色 .zjbook 听书包：女声、男声逐段 MP3，妈妈导入后可离线听；也可只生成一种声音节省空间。
- Markdown 标记清理、Word 段落和标题提取、章节目录、搜索和书架管理。
- 正文阅读、字号 16–32、宋体/黑体、行距和暖纸/护眼绿/夜间主题。
- 点击任意段落开始听，上一段/下一段、拖动进度、章节跳转、阅读和听书共用位置。
- 0.5–2 倍语速、实际可用的系统音色、15/30/60 分钟定时停止。
- 自动保存正文、进度与偏好，支持添加主屏幕；HTTPS 下可缓存应用以离线打开。
- 内置两篇原创体验短篇，可自行移除。

## 免费公网部署（电脑无需常开）

项目已经包含 GitHub Pages 自动部署工作流。发布一次后，妈妈可用 iPhone 在外面通过 HTTPS 地址打开；网站由 GitHub 托管，日常使用不需要你的电脑在线，也不要求同一 Wi-Fi。GitHub 仓库只放应用代码，**不要把小说原稿、私人资料或听书音频放进公开仓库**。小说仍由妈妈从自己的手机导入。

首次部署需要一个 GitHub 账号：

1. 在 GitHub 创建一个**公开**的空仓库，例如“jian-reader”。不要勾选自动创建 README 或 .gitignore。
2. 在新仓库的“Settings → Pages → Build and deployment”中把 Source 选为“GitHub Actions”。
3. 在本项目文件夹打开 PowerShell，运行下面的命令。先把网址中的用户名和仓库名换成你自己的；若已设置同名 origin，跳过添加远程仓库那一行。

~~~powershell
git branch -M main
git remote add origin 'https://github.com/你的用户名/你的仓库名.git'
git add .github .gitignore README.md index.html package.json package-lock.json public scripts src tests
git commit -m 'Publish reader'
git push -u origin main
~~~

4. 在仓库“Actions”中等“Deploy reader to GitHub Pages”成功。正式地址显示在“Settings → Pages”，通常是 https://你的用户名.github.io/你的仓库名/ 。把这个地址发给妈妈，用 Safari 打开即可。“分享 → 添加到主屏幕”可像 App 一样使用。

今后改好应用后再次提交并推送，工作流会自动运行测试、构建和部署。当前项目尚未连接远程仓库，因此还没有可使用的公网地址。

截至 2026-11-05，[GitHub Free 支持公开仓库的 Pages](https://docs.github.com/en/pages/getting-started-with-github-pages)，公开仓库使用的标准 Linux Actions 运行器也免费。[Pages 使用限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)包括：发布后的网站不超过 1 GB，流量软上限为每月 100 GB，部署超过 10 分钟会超时。此项目的工作流只上传 dist 中的应用静态资源。免费规则可能调整，正式地址也应先用妈妈手机的蜂窝网络打开验证。

## 本机与手机试用

需要 Node.js 22.18 或更新版本。

```powershell
npm install
npm test
npm run build
npm start
```

电脑打开终端显示的 `http://localhost:5180/`。这一段仅供开发试用：iPhone 与电脑连接同一 Wi-Fi 后，可以在 Safari 打开终端显示的局域网地址，例如 `http://192.168.1.10:5180/`。外出时请使用上面的公网部署地址。

构建完成后也可以双击「启动纸间.cmd」。开发界面使用 `npm run dev`，Vite 默认端口为 5173。不要双击 index.html：模块和本地存储需要 HTTP 服务。

## 生成自然语音听书包

在作者的 Windows 电脑上安装 Node.js 22.18+ 和 Python 3，然后双击「scripts/生成听书包.cmd」。按提示把小说文件拖进窗口；首次运行会安装免费的 `edge-tts`。脚本默认生成女声“小晓”和男声“云希”，输出的 `.zjbook` 与原文档放在同一文件夹。把这个包私下发给妈妈即可；生成完后电脑可以关机，妈妈播放时不会再次调用语音服务。

也可以在 PowerShell 运行：

~~~powershell
node scripts/make-zjbook.mjs --input 'C:\小说\我的小说.md'
# 只生成女声以减小文件体积
node scripts/make-zjbook.mjs --input 'C:\小说\我的小说.md' --voices female
~~~

支持 `.md`、`.txt`、`.docx`。`--dry-run` 可以先检查段落数量而不联网。双声包最多 300 MB；超过后请按卷拆分原稿，或使用 `--voices female` / `--voices male` 生成单声包。一个原文档最多 20 MB。

**隐私与费用：**生成时，作者电脑会把小说正文逐段发送到 Microsoft Edge 的在线语音服务；不要把不能交给该服务的未发表内容用于生成。网站和妈妈手机不会为已生成的音频再次上传正文。`edge-tts` 是调用该在线服务的免费开源工具，属于非官方接入；声音供应、服务稳定性及使用规则可能变化。音质比常见浏览器系统朗读自然，但并非真人录音。

## 给妈妈使用

1. 把收到的 .zjbook 听书包「存储到文件」。也可以导入普通 Word / Markdown 文档阅读，但普通文档只有系统朗读。
2. 用 Safari 打开纸间公网地址，点右上角「＋」选择听书包。首次导入时需要等待音频保存完成。
3. 点书架上的小说开始看；想听时轻点正文中的某一段。
4. 到「听书」页面调整语速、声音或定时；到「阅读设置」调字号。
5. 正式 HTTPS 网站可通过 Safari「分享 → 添加到主屏幕」安装。联网打开一次完成应用缓存、并成功导入听书包后，可在外面离线阅读、收听；先用飞行模式试播一小段确认。

旧版 `.doc` 需要先用 Word/WPS 另存为 `.docx` 或 TXT。图片扫描版 Word 没有可提取的文字，需先识别文字。导入只保留小说正文和标题，不保留 Word 排版、插图、批注或已删除的修订。

## iPhone 的实际边界

- .zjbook 包使用提前生成的 MP3，女声和男声由包本身提供，手机无需安装额外声音；音频保存在本机。
- 普通 Word / Markdown / TXT 文档仍使用浏览器 SpeechSynthesis，音色取决于手机实际提供的系统声音。应用显示声音的真实名称。
- 可以在 iPhone「设置 → 辅助功能 → 朗读内容（不同系统版本也可能叫朗读与语音）→ 声音 → 中文」中下载声音，再重新打开应用。系统未必会把每个下载的声音开放给 Safari。
- .zjbook 的 MP3 使用浏览器音频播放；锁屏、后台播放与跨段自动续播受 iOS 调度影响，仍需在真实 iPhone 上验证，不能保证长期连续播放。系统朗读更容易在锁屏或切换应用后中止，建议保持页面前台。支持时会申请屏幕常亮。
- 普通文档离线朗读需要已有本机声音，远程系统声音可能联网。听书包的已存音频不需要联网。
- 阅读进度按段落保存。系统朗读暂停后恢复会重播当前的一小段；重新打开小说也会从保存的段落开始。
- 普通局域网 HTTP 地址可以试用，Service Worker 离线缓存需要 HTTPS 或 localhost。Safari 私密浏览、清除网站数据或设备清理可能删除书架，务必保留原始文档。

## 数据与地址

`npm run build` 生成 `dist/`，也可以将整个目录部署到其他支持 HTTPS 的静态网站托管（支持子目录）。不需要服务器数据库或读者账号；网站资源可以公开托管，小说仍由妈妈本地导入，不随网站发布。

运行 `npm run build` 会生成安装图标与包含内容版本号的 Service Worker。应用静态资源放在离线缓存中；妈妈导入的小说与音频放在 IndexedDB，不发往托管站点。生成听书包是作者主动运行的独立联网步骤，会把正文发送给在线语音服务。更换域名/协议/端口会形成不同的本地书架，听书包需在新地址重新导入。请保留原稿和听书包备份，Safari 清理网站数据可能清空本机书架。

## 验证

`npm test` 使用 Node 内置测试，覆盖 Markdown/TXT/Word 内容与章节解析、听书包结构与错误文件拒绝、逐段音频选择及播放控制、系统朗读和本地设置。已用原创短篇实际生成女声/男声 MP3，并通过网页端听书包解析；测试不会上传用户原稿。构建命令验证生产资源可打包。尚未在真实 iPhone 设备上验证锁屏与长时间续播。

结构：`src/main.js` 界面与交互，`src/importer.js` 文档解析，`src/audio-package.js` 听书包解析，`src/audio-player.js` 音频播放，`src/speech.js` 系统朗读，`src/storage.js` 本地持久化，`scripts/make-zjbook.mjs` 听书包生成器。网页无远程字体、统计或外部内容依赖。
