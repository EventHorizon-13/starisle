# GitHub / Docker Hub 发布维护

源码已于2026-10-19公开至 [EventHorizon-13/starisle](https://github.com/EventHorizon-13/starisle)。Docker Hub 镜像尚未发布，镜像命名空间与凭据仍需单独配置。

## 发布前

1. GitHub 仓库短名定为 `starisle`，Docker Hub 镜像短名定为 `starisle`；发布前确定账号命名空间，检查 README、版本、许可证与 THIRD_PARTY_NOTICES。
2. 在独立安装目录完成 basic/full 初始化，运行测试并检查页面。
3. `.github/workflows/ci.yml` 执行单元测试和 amd64/arm64 构建，不上传镜像。需要联网下载基础星历、Hipparcos及校验固定的AT-HYG/OpenNGC目录源，并生成中文别名测试所需索引；不下载数GiB的额外自然卫星星历。网络失败不代表天文算法回归。
4. `.github/workflows/docker.yml` 仅通过手动 workflow_dispatch 运行，默认 `publish=false`。准备阶段不要执行发布。

## 账号配置与手动发布

GitHub Repository variable `DOCKERHUB_IMAGE` 设为实际 `用户名/仓库`。Secrets：`DOCKERHUB_USERNAME` 与具有相应仓库写权限的 `DOCKERHUB_TOKEN`。token 只放 GitHub Secrets，不写入文件。

明确决定发布后，手动运行 Docker workflow，填写版本并设置 publish=true。构建标签 `版本` 与 `latest`，目标平台 linux/amd64、linux/arm64；不在普通提交或 pull request 时推镜像。修改版本时同步应用版本、Dockerfile 默认值、Compose/.env 示例及 CHANGELOG。

建议先打版本 tag，再从该 tag 手动运行工作流。保留固定版本标签，README 使用版本标签示例。

## 恢复与生产部署

发布版与生产部署分开测试。不要从发布候选目录直接重建或覆盖正在运行的服务。升级生产前另做数据库和数据备份，确认差异后再安排切换。

## 验证记录

准备阶段的实机验证在 ARM64 主机进行；amd64/arm64 双平台构建由 CI 配置覆盖，未运行远端 CI 前不把 amd64 标为已实机验证。GitHub 仓库已指定；后续镜像发布前仍需指定镜像名并确认相应工作流结果。
