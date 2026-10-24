<div align="center">
  <img src="https://raw.githubusercontent.com/voyager-crew/voyager-cli/main/assets/logo.svg" alt="Voyager CLI logo" width="96" height="96">
  <h1>Voyager CLI</h1>
  <p>在终端里向 ChatGPT 提问，或者交给你的 coding agent 去问，<br>用的就是你浏览器里已经登录的那个 ChatGPT。</p>
  <p>
    <a href="https://www.npmjs.com/package/@voyager-crew/cli"><img src="https://img.shields.io/npm/v/@voyager-crew/cli?style=flat-square" alt="npm version"></a>
    <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
  </p>
  <p><a href="README.md">English</a> • <b>简体中文</b></p>
</div>

```sh
voyager ask "帮我审一下这份设计" --attach ./docs/design.md
```

Voyager CLI 是 [Voyager](https://github.com/voyager-crew/voyager) 浏览器插件里 **ChatGPT 本地桥**
的参考客户端。本地桥让本机程序可以跟 ChatGPT 网页版协作：打开对话、附文件发送、等回复写完再读取、管理项目文件。Voyager CLI
把这些带到终端里，每次的回答存成 `response.md`。全程都在你自己的电脑上：命令行只监听 `127.0.0.1`，ChatGPT
看到的就是你浏览器里一次普通的对话。[了解本地桥 →](https://voyager.nagi.fun/guide/local-bridge)

## 安装

1. 安装 Voyager CLI（需要 Node.js 20.3 或更高版本）：

   ```sh
   npm install -g @voyager-crew/cli
   ```

2. 安装 Voyager 插件，需要 2.1.0 或更高版本（`--approve-apps` 和保存回复里的文件需要 2.2.0）：
   [Chrome](https://chromewebstore.google.com/detail/iifacdnjakkhjjiengaffnegbndgingi) ·
   [Edge](https://microsoftedge.microsoft.com/addons/detail/voyager/gibmkggjijalcjinbdhcpklodjkhhlne) ·
   [Firefox](https://addons.mozilla.org/firefox/addon/gemini-voyager/)。打开插件弹窗，进入
   **插件**，打开 **ChatGPT · 本地桥**，并允许访问 chatgpt.com。
3. 配对一次：

   ```sh
   voyager pair
   ```

   在 ChatGPT 标签页上打开 Voyager 弹窗，把它显示的 8 位配对码填进「本地桥接」的设置。

## 提问

```sh
voyager ask "解释一下这段报错" --attach crash.log
voyager ask "看看这个仓库" --attach ./src          # 文件夹会打包成 zip，自动去掉密钥等凭据
voyager ask --model high "快速检查一下"            # pro（默认）、extra-high、high、medium、instant
voyager ask --chat <链接|id> "边界情况呢？"         # 在已有对话里接着问
voyager read <链接|id>                             # 保存某个对话的最新回答
```

默认用聊天模式下的 GPT-6 Pro，除非你另选思考强度；问完保持在这个选择上。Voyager 不会把 ChatGPT
切到「工作」模式。回答保存在 `~/.voyager/jobs/<id>/output/`，加 `--json` 会输出文件路径和对话链接。

回答里给出的文件（ChatGPT 生成的 CSV、图表、zip 等）会存到旁边的 `files/` 里，重名的依次加 `-2`、`-3`；
加 `--no-files` 就不下载。某个文件下载失败只会报告，不会让命令失败，因为回答本身已经保存：之后可以用
`voyager read <链接>` 再取一次。

### 很长的回答

Pro 可能要想好几个小时。只要 ChatGPT 还在写，`ask` 就一直等；连续 20 分钟完全没动静才算失败。想先拿回终端，就先提交、之后再取：

```sh
voyager ask --no-wait "…"            # 输出一个任务 id
voyager job wait <id> --timeout 10m  # 退出码 4 表示还在跑：接着等，千万别重发问题
```

Pro 在 ChatGPT 沙箱里做构建、运行、渲染这类重活时，大约 80 分钟后连接可能会断，断了就什么都不交。`--timebox 70` 让它到 70 分钟就收尾，把手上的东西交出来：成品和半成品分开，打成一个 ZIP。

## 项目

ChatGPT 的项目可以存放文件，项目里的每个对话都能读到。代码库或论文传一次就行，不用每次提问都附上。

```sh
voyager project create "论文"
voyager project upload "论文" ./thesis             # 内容变了就替换，没变就跳过
voyager ask --project "论文" "论证最薄弱的地方在哪？"
voyager project files "论文"
voyager project remove "论文" old-notes.md         # 立即删除且无法恢复，会先确认
```

## Google Drive 和 GitHub

ChatGPT 自带的 Google Drive 和 GitHub 应用可以直接读你的文件，不用再经过网页上传。先在 ChatGPT 里连上它们。

```sh
voyager ask --drive ./paper.pdf "总结一下方法部分"   # 放到 Drive 上，把链接写进提示
voyager ask --repo owner/name "CI 为什么挂了？"       # 让 ChatGPT 的 GitHub 应用读这个仓库
```

`--drive` 的打包方式和 `--attach` 一样，但没有 64 MiB 的限制（文件夹里超过 20 MiB 的单个文件仍会被跳过），用 [rclone](https://rclone.org/drive/) 上传：
把 `VOYAGER_DRIVE_REMOTE`（或 `~/.voyager/config.json` 里的 `"driveRemote"`）设成某个 Google Drive remote 上的文件夹，
比如 `gdrive:Voyager`，而且要和 ChatGPT 的 Drive 应用是同一个 Google 账号。文件会一直留在那里。

`--repo` 会要求 ChatGPT 只往一个新的 `chatgpt/*` 分支提交，你看过再合并。这只是要求，不是限制：它的 GitHub
安装能写到哪里，它就能写到哪里，而且不会先问你。读不到仓库时，voyager 以退出码 3 停下，去
[github.com/settings/installations](https://github.com/settings/installations) 把仓库加上就行。

做某些操作之前（比如往 Drive 写文件），ChatGPT 会在回答里停下，弹一张卡问「允许 ChatGPT 使用 Google Drive 吗？」。
这时 voyager 以退出码 3 停下，并给出对话链接，你去那里点。插件 2.2.0 及以上，加 `--approve-apps always` 就由插件替你点「始终允许」，
`--approve-apps once` 点「允许一次」。点过「始终允许」，这张卡之后也可能再出现。

## 给 agent 用

Claude Code、Codex 以及任何能运行终端命令的 agent 都能用 Voyager CLI。先装上教它们怎么用的 skill：

```sh
npx skills add voyager-crew/voyager-cli
```

[`skills/voyager/SKILL.md`](skills/voyager/SKILL.md) 就是写给它们看的：JSON 输出、每个退出码的含义、怎么等长任务而不把问题发两遍，以及接着问时用
`--chat` 加上次拿到的对话 id，而不是 `--continue`。

默认同一时间只跑一个任务。在 Voyager 弹窗的 **本地桥接** 卡片里打开 **并行运行任务**（2.2.1 之后发布的
Voyager 版本），并在那里选好同时跑几个（2 到 10 个）后，这么多任务同时进行，各用自己的 ChatGPT 标签页：几个
agent 可以同时提问，回复一起等；输入和点击仍会轮流进行。轮到自己之前，任务会一直等到另一个任务的那一步
允许用完的时间（大文件上传最长 10 分钟）；只有那个任务超时卡住，才在自己这一步之前按 busy 停下（退出码 5）。往同一个对话里的两次提问、两次项目改动不会同时进行，后来的那个按 busy 拒绝（退出码 5）。
想少跑几个，在 `~/.voyager/config.json` 里写 `"maxParallelJobs": 2`；每个在跑的任务都是一次单独的 Pro 请求。
`voyager status` 会显示现在最多能同时跑几个，以及哪个任务正在操作页面。

每次的结果里还会带上你的 ChatGPT 套餐（`Pro Lite ($100)`、`Pro ($200)` 等），以页面最近一次报告的为准。

## 须知

- `ask`、`read` 和所有 `project` 命令都会自己打开一个 ChatGPT 标签页，结束时关掉，失败了也关；
  想留着就加 `--keep-tab`。如果 ChatGPT 要求登录或人机验证，Voyager CLI 会停下来、留着那个
  标签页并告诉你（退出码 3），不会绕过。
- `voyager update` 把能更新的都更新一遍：命令行本身（用 npm 全局安装时）、`voyager serve`
  （没有任务在跑时重启）和扩展的页面数据（立即重新获取，不等下一次定时检查）。扩展本身由浏览器的
  扩展商店更新。
- 全部命令见 `voyager --help`。状态保存在 `~/.voyager`（或 `$VOYAGER_HOME`），只有你的用户能读。
- 已在 Chrome 中测试。Edge 和 Firefox 版的 Voyager 也带这个桥；Safari 版没有。

## 须知与免责

- Voyager 和 Voyager CLI 是社区开源项目，与 OpenAI 无关，也没有得到 OpenAI 的认可。
- 本地桥会在你自己登录的浏览器里自动操作 ChatGPT 网页版。OpenAI 的[使用条款](https://openai.com/policies/terms-of-use/)限制以自动或程序化的方式提取输出，使用前请自行判断是否符合条款；账号因此受到的任何限制，由你自己承担。
- 同类工具也是这样处理的：例如 [oracle](https://github.com/steipete/oracle) 把浏览器模式作为需要主动开启的实验功能，并建议在意风险的人改用 API。需要有保障的用法，请使用 OpenAI API。
- 本地桥是给你在自己电脑上、为自己方便而用的：只连你自己的账号，不要拿它对外提供服务、共享账号或转卖额度，也只用于合法用途。

## 许可证

MIT。开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
