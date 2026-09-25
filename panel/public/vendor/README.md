# public/vendor —— 前端第三方库

这个目录只放**原样 vendored** 的前端库（同源加载，不走 CDN），便于离线部署与 CSP 收紧。

## echarts.min.js

| 项 | 值 |
| --- | --- |
| 名称 | Apache ECharts |
| 版本 | 6.1.0 |
| 构建 | **全量构建**（`dist/echarts.min.js`）。趋势图用到的折线 / 双 Y 轴 / time 轴 / tooltip / legend / aria、`markLine` / `markArea` / `markPoint` 标注组件、以及 custom series 的 `renderItem` 全部包含。**不要换回 `common` / `simple` 等部分构建**：`common` 不含 custom series 实现（压缩版里 `renderItem` 出现 0 次，「无数据」带这类自定义图元会静默不渲染），`simple` 连 `mark*` 组件实现都没有（配置能写进 option 但运行期静默不渲染）。Node 测试不会报错，只有浏览器里才看得出丢了功能 —— 两类坑都踩过，勿换回。 |
| 来源 | npm 官方 registry 的 `echarts` 包（`npm pack echarts@6.1.0` → `dist/echarts.min.js`），tarball shasum 已与 npm 官方发布值核对 |
| 许可证 | Apache-2.0（完整文本见 <https://www.apache.org/licenses/LICENSE-2.0>；文件头保留了 ASF 版权与许可声明） |
| 文件大小 | 1121883 字节（约 1.07 MiB） |
| sha256 | `b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0` |

用途：`public/js/render-trend.js` 绘制「近 24 小时趋势」时的**懒加载**运行时 —— 趋势区第一次渲染时才动态插入
`<script src="vendor/echarts.min.js">`；`index.html` 里**没有**静态 script 标签，首屏不为这 ~1.1MB 买单。

### 升级步骤

1. 从 npm 官方 tarball 取新版本的 `dist/echarts.min.js` 全量构建（**不要用 `common` / `simple`，会分别静默丢 custom series 与 mark\* 标注**），覆盖本文件；
2. 更新本 README 的版本 / 大小 / sha256，并同步 `test/trend-echarts-b21.test.mjs` 里锁定的构建身份（sha256 + `mark*` 计数 + `renderItem` 计数）；
3. **改文件名或加版本参数**（例如 `echarts.min.js` → `echarts-6.2.0.min.js`），并同步 `render-trend.js` 里的
   `TREND_ECHARTS_SRC`。`/vendor/` 下的文件带一年 `immutable` 长缓存（见 `gateway.mjs` 的 `serveStatic`），
   沿用同名会让老客户端一直吃旧缓存。
