# Docker Hub 仓库简介草稿

星屿 · StarIsle / StarIsle：手机友好的中文自托管星图，包含太阳系、月相、人造卫星轨迹和目录搜索。

应用镜像不内置约 3 GiB 天文数据。安装后可选择基础或完整初始化，数据挂载到 `/data`。首次下载会核对文件大小与 SHA256；已准备数据可离线运行。

部署方式：从 [GitHub 项目](https://github.com/EventHorizon-13/starisle)取得 Compose 与 `.env.example`，设置 `STARISLE_IMAGE` 为实际镜像名与固定版本；使用 README 的初始化和启动步骤。

镜像平台目标：linux/amd64、linux/arm64。请以实际发布的 manifest 为准。HTTP 端口 8000；默认 Compose 映射到宿主回环 18080。

应用代码采用 MIT；部分目录数据为 CC BY-SA 4.0，NASA 图片和其他数据保留来源条款。镜像内 `/app/THIRD_PARTY_NOTICES.md`、`/app/CATALOG_LICENSES.md` 和 `/app/LICENSES/` 包含署名与许可。

镜像发布时补入 Docker Hub 实际仓库名、版本标签和安装说明链接。本文件为草稿，不代表镜像已公开。
