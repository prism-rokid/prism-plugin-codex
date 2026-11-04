# GitHub 贡献流程

本文件只在准备提交 PR 或 Issue 时阅读。所有变更都受 SKILL.md 的授权范围约束；工具可用、登录成功或有仓库写权限本身不构成用户授权。

## 确定目标与草稿

1. 用 `git remote -v` 和 `gh repo view OWNER/REPO --json nameWithOwner,defaultBranchRef,isFork,parent` 验证项目上游及默认分支。插件故障提交到对应插件仓库；只有证据表明问题属于 SDK，且用户授权覆盖 SDK 仓库时，才提交 SDK。目标不明确时先准备本地结果，再确认目标。
2. 读取目标仓库 `.github/` 下的贡献模板和贡献指南，并用 `gh issue list --repo OWNER/REPO --state all --search '关键现象'`、`gh pr list --repo OWNER/REPO --state all --search '关键现象'` 检查已有记录。已有同类问题时返回链接；补充评论或更新已有记录也需要相应授权。
3. 在仓库外的临时文件中准备最终正文，避免将用户诊断资料意外提交。PR 写明问题、修复、实际验证与限制；Issue 写明最小复现、环境版本、实际/期望行为、诊断尝试及仍未知之处。缺少复现就标明“尚未复现”，不能补造结果。
4. 检查正文、附件、代码 diff 与即将推送的提交，不上传 `.env`、令牌、私有会话、完整日志或无关改动。说明 GitHub 目标仓库的可见性，公开仓库中的提交内容将公开；授权确认应覆盖实际披露范围。

## 提交修复 PR

在已授权流程中完成下列操作；没有授权时先交付草稿：

- 在独立工作分支上工作，基于上游目标分支检查 `git log BASE..HEAD` 和 `git diff BASE...HEAD`，确保 PR 不夹带用户已有提交或无关代码。无法安全分离时保留原 checkout，使用独立 checkout/worktree 搬运本任务改动。
- 有上游写权限时推送独立分支；否则使用用户已有 fork。创建新 fork 需要授权覆盖该操作。不要因没有写权限而推送到猜测的仓库。
- 用 `git add -- 文件路径` 仅暂存本任务文件，审阅 `git diff --cached` 后按仓库约定创建 commit；不要使用 `git add .`、`commit -a`、强制推送或提交凭据文件。
- 通过明确的 remote 和分支执行 push，然后显式指定目标、base 和 head 创建 PR。下面是命令结构，执行时以已确认值替换占位符，不要直接照抄：

```bash
git push CONTRIBUTION_REMOTE WORK_BRANCH
gh pr create --repo OWNER/REPO --base BASE_BRANCH --head HEAD_OWNER:WORK_BRANCH --title '修复标题' --body-file /绝对路径/pr-body.md
```

- 优先提交验证通过的修复；验证受环境限制时如实说明，若用户同意仍提交则创建 Draft PR。授权只允许创建 PR 时，不自动更新他人 PR 或自动合并。

## 提交无法本地解决的问题 Issue

已获“本地无法解决时自动提 Issue”授权的任务，在确认兜底条件、去重与脱敏后直接执行；否则先展示草稿并请求发布授权。不要把未验证的修复宣称为已解决。

```bash
gh issue create --repo OWNER/REPO --title '问题标题' --body-file /绝对路径/issue-body.md
```

## 失败与结果

- 使用 `--body-file` 保留正文换行并避免 shell 解释其中的反引号和命令片段。所有路径和参数都需按所在 shell 正确引用。
- 认证缺失时请用户自行登录，不收集令牌、不修改用户凭据；网络失败或权限拒绝时保留本地结果。
- 写入超时后先按目标仓库、分支和标题查询是否已成功；没有查清状态前不再次创建，避免重复 PR/Issue。
- 成功后用返回的 URL 查询确认目标与内容，向用户报告真实链接、提交分支和验证结果。宿主若提供 PR 附件能力，同时将本次 PR 附加到当前任务。
