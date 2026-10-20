# 镜像仓库已改为 GHCR

项目使用GitHub Container Registry，无需Docker Hub账号。镜像地址：`ghcr.io/eventhorizon-13/starisle:0.6.0`，另提供`latest`。

详情见[发布维护](RELEASING.md)与[安装说明](../README.md)。首次发布后须将GHCR包可见性设为Public，才可匿名拉取。

镜像不内置约3 GiB完整天文数据，应用代码与原创图标为MIT，第三方数据与图片保留独立许可。镜像内`/app/THIRD_PARTY_NOTICES.md`、`/app/CATALOG_LICENSES.md`及`/app/LICENSES/`包含出处与许可。
