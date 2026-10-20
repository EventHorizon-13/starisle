# 星屿 · StarIsle

**在自己的服务器上，看见星空。**

面向家庭观星与科普的中文自托管天文应用，把星图、太阳系、月相和空间站过境预报放进同一个手机友好的网页。浏览器选择地点与时间，服务端使用 Skyfield、JPL 星历和星表计算天空。

[项目仓库](https://github.com/EventHorizon-13/starisle) · [English](README.en.md) · [数据来源与许可](THIRD_PARTY_NOTICES.md) · [发布说明](docs/RELEASING.md)

- 星图：亮星、10 等深星层、梅西耶与 NGC/IC、中文名称和目录编号搜索。
- 太阳系：行星、冥王星及主要自然卫星，支持时间轴和轨道展示。
- 月相：月历、照明比例、月龄和主要月相时刻。
- 人造卫星：中国空间站、ISS、哈勃与公开亮卫星；轨迹和未来 48 小时可观测过境。
- 手机触控、全屏与主屏幕安装。静态资源可缓存；新的计算仍需要服务器。

位置设置存于浏览器，计算时坐标会发送给你部署的服务端。项目不接入第三方统计服务。

## 为什么选择 StarIsle

StarIsle 面向想在自家服务器、NAS 或局域网部署中文观星工具的人：部署一个服务，家人用手机浏览器就能查看指定地点和时间的天空。它把以下能力放在同一套可自行维护的应用里：

- **中文名称直接找星**：支持已收录的中文星名、英文别名和目录编号，例如“南门二A”；明确区分已收录的双星成员。中文名称覆盖仍在补充，不代表完整的中国星官体系。
- **从今晚星空切换到太阳系和月相**：星图查看天体方位、高度和今日升落，太阳系查看行星与主要自然卫星，月历查看月相与关键时刻，适合日常观星和家庭科普。
- **兼顾空间站观测**：内置中国空间站、ISS、哈勃等目标，展示轨迹和未来48小时的可观测过境；按太阳高度、卫星受光和仰角筛选。预报受轨道数据新鲜度、天气与遮挡影响。
- **数据与服务由自己管理**：Compose 部署，基础与完整数据分档初始化并校验下载文件；准备好数据后可关闭运行时下载。位置偏好保存在浏览器，坐标发送给自建服务端计算，无第三方统计集成。
- **手机入口与服务端计算分工**：支持触控和主屏幕安装，Skyfield/JPL 计算在自建服务器执行。离线模式指服务端无需外网下载；手机仍需连接该服务器。

### 与同类项目的侧重点

下表比较使用方式与本项目侧重点，不是排他的功能清单；其他项目也可能提供相同能力。

| 项目／使用方式 | 官方定位 | StarIsle 的侧重点 |
|---|---|---|
| [Stellarium Web](https://stellarium-labs.com/stellarium-web/) | 浏览器中的在线天象馆 | 为自行部署准备完整应用、Compose 与数据初始化流程，突出中文查星、月历和空间站过境的日常使用。 |
| [Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine) | 可用于开发天象馆的 JavaScript 引擎 | 提供现成的 Python/Skyfield 服务端与手机界面，适合希望部署整套应用的用户。 |
| [VirtualSky](https://github.com/slowe/VirtualSky) | 可定制、可嵌入网页的浏览器天象馆 | 将星图、太阳系、月相与卫星预报组织为独立应用，并提供本地星历、目录与轨道缓存的维护路径。 |

这些差异来自各项目官方定位与 StarIsle 当前候选版的功能组合，不表示 StarIsle 在精度、星表规模或渲染效果上优于其他项目。需要专业观测或精密计算时，请先核对本项目下方的计算范围与限制。

## Docker Compose 安装

需要 Docker Engine 与 Compose 插件。先下载/克隆本项目，进入目录：

```sh
git clone https://github.com/EventHorizon-13/starisle.git
cd starisle
cp .env.example .env
docker compose pull starisle
# 基础星历与亮星表：约 165 MiB，需联网首次下载。
docker compose run --rm --no-deps --no-build starisle python scripts/init_data.py --profile basic
docker compose up -d --no-build
```

打开 `http://localhost:18080`。默认只绑定本机回环地址；需要 LAN 访问时，将 `.env` 中 `BIND_ADDRESS` 改为 `0.0.0.0`，用服务器地址访问。浏览器自动定位需要 HTTPS，HTTP 下可以手填经纬度。

基础版有亮星、行星、月相和随应用提供的深空目录。首次人造卫星轨道下载需要联网；基础版不包含 10 等深星搜索库与行星自然卫星的额外星历。

### 完整数据

先停止这个部署实例，再初始化，避免替换运行中使用的目录：

```sh
docker compose stop starisle
docker compose run --rm --no-deps --no-build starisle python scripts/init_data.py --profile full
docker compose up -d --no-build
```

完整配置需要约 3 GiB 星历与星表；目录生成和下载缓存还需要额外空间，建议至少 5 GiB 可用。已有校验匹配的下载会复用。下载与 SHA256 检查成功后才写正式文件；目录构建失败会保留已有目录。上游文件发生变化会拒绝导入，详见 [数据说明](docs/DATA.md)。

### 使用预构建镜像

镜像地址为 `ghcr.io/eventhorizon-13/starisle:0.6.0`（另提供 `latest`），支持 `linux/amd64` 和 `linux/arm64`。镜像在 GitHub Actions 构建并上传，无需 Docker Hub 账号。首次发布需将 GHCR 包可见性设为 Public，才可匿名拉取；以[包页面](https://github.com/EventHorizon-13/starisle/pkgs/container/starisle)和[发布工作流](https://github.com/EventHorizon-13/starisle/actions/workflows/docker.yml)的实际结果为准。

安装步骤默认拉取预构建镜像。若自行构建，先在 `.env` 设 `STARISLE_IMAGE=starisle:local`，再运行 `docker compose build`；随后沿用数据初始化及启动步骤。完整天文数据独立存储在 `data/`，不随镜像发布。

## 配置

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `18080` | 宿主 HTTP 端口 |
| `BIND_ADDRESS` | `127.0.0.1` | 监听地址 |
| `STARISLE_IMAGE` | `ghcr.io/eventhorizon-13/starisle:0.6.0` | 固定版本镜像，也可改为本地构建标签 |
| `OFFLINE` | `false` | `true` 禁止应用运行时下载；必须先准备基础数据 |
| `IERS_UPDATE` | `false` | 联网更新地球定向表；默认使用 Skyfield 随包数据 |
| `PIP_INDEX_URL` | `https://pypi.org/simple` | 构建时 Python 包源 |

应用还支持 `DATA_DIR`、`STAR_LIMIT`、`DEEP_STAR_LIMIT`、`TRAIL_STAR_MAG`、`LOG_LEVEL`、`EPHEMERIS_URL`。Compose 已将 `DATA_DIR` 设置为持久目录 `/data`。

离线运行前初始化数据，再设置 `OFFLINE=true`；人造卫星位置依赖轨道缓存的新鲜度，离线久了会降级或不显示。不要将别人的运行历史数据库当作安装必需文件。

## 维护

```sh
docker compose logs --tail 100 starisle
curl http://localhost:18080/api/health
```

升级前备份 Compose/.env 和 `data/`。SQLite 用在线 backup API 或停止本实例后备份，不能只复制 WAL 模式的主数据库。不要把 `data/`、`.env`、数据库或个人运维记录提交到 Git。

服务没有账号系统；需要公网访问时自行配置 HTTPS 与访问控制，并按部署需求限制请求资源。计算地点只用于当前请求，反代或宿主访问日志的保存策略由部署者管理。

## 计算范围与限制

- DE440 日期范围：1550-01-01 至 2650-01-25；自然卫星星历范围各不相同。
- 小行星/彗星的长期位置使用二体近似；轨迹展示不作为专业航天或精密观测依据。
- 卫星轨道距观测时间超过 2 天会提示，超过 7 天不绘制；历史准确度取决于本实例开始积累的轨道数据。
- 可观测过境按太阳高度、卫星受光和仰角筛选；实际可见性还受天气、亮度与遮挡影响。

## 开发与测试

Python 3.12：`pip install -r requirements.txt`。基础数据准备后执行：

```sh
DATA_DIR=./data OFFLINE=true python -m unittest discover -s tests -p 'test_*.py'
```

`tests/test_init_data.py` 不依赖天文数据。浏览器回归脚本使用 Playwright，见 [贡献说明](CONTRIBUTING.md)。

## 许可

应用代码和原创图标采用 [MIT](LICENSE)。OpenNGC、AT-HYG 衍生目录采用 **CC BY-SA 4.0**；NASA 图片、JPL/CDS/IERS/CelesTrak 数据及 Python 依赖分别遵守其来源条款。完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [CATALOG_LICENSES.md](CATALOG_LICENSES.md)。
