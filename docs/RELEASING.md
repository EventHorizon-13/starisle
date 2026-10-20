# GitHub / GHCR 发布维护

源码：[EventHorizon-13/starisle](https://github.com/EventHorizon-13/starisle)。镜像：`ghcr.io/eventhorizon-13/starisle`；不需要Docker Hub账号或长期访问令牌。

## 构建与发布

- `.github/workflows/ci.yml` 运行测试与amd64/arm64构建，不上传镜像。它下载校验固定的基础星历和AT-HYG/OpenNGC源并生成测试目录，不下载额外自然卫星星历。
- `.github/workflows/docker.yml` 仅在main修改该工作流时自动发布（默认版本0.6.0），或通过手动Run workflow运行。手动运行默认publish=false，仅验证构建；明确发布时设置publish=true与版本号。普通源码/文档提交和PR不自动发布镜像。
- 发布先等待完整CI成功，随后在GitHub托管runner构建并上传linux/amd64、linux/arm64，写入版本与latest标签，校验远端manifest并在运行摘要记录digest。
- workflow使用最小的contents:read、发布job专用packages:write和临时GITHUB_TOKEN登录ghcr.io；无需新增账号、Secrets或自托管runner。main以外不执行发布job。

## 公开与验证

2026-10-20发布运行39357461528与匿名验收39358109773均通过。0.6.0/latest摘要一致：`sha256:2843f54016bdef8f46756d3e5bc555140eb557aeac67961f1eceb4235385d5ff`。amd64/arm64压缩图层合计分别100578461/101085154字节，均标记源码提交`fdaaf21ef124519e928a60dfe22de4f05e5297ee`。

新建GHCR包时仍应单独确认可见性；本项目当前已通过匿名验收。发布后打开[包页面](https://github.com/EventHorizon-13/starisle/pkgs/container/starisle)的Package settings → Change visibility → Public。没有公开前，不能把匿名拉取描述为已通过。

匿名安装检查：`docker manifest inspect ghcr.io/eventhorizon-13/starisle:0.6.0`；应包含amd64和arm64。无需下载图层即可检查manifest。镜像标签可变，生产部署可用发布摘要中的`ghcr.io/eventhorizon-13/starisle@sha256:...`固定内容。

修改版本时同步应用版本、Dockerfile默认值、Compose/.env、README与CHANGELOG。正式版本标签应保留，不覆盖不同源码内容。

## 生产部署

镜像发布不等于更新现有生产站点。升级生产需另做数据备份、确认差异及安排切换，不直接用发布目录覆盖运行中的服务。完整天文数据由使用者初始化，不打进镜像。
