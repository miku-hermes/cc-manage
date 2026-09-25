import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// B24：前端完整重构 —— Astro 只做页面骨架，样式交给 Tailwind v4 + daisyUI 5。
//
// 产物格式仍是 file：/admin 输出 admin.html、/trend 输出 trend.html，与 gateway 的显式路由对齐。
// B24d：样式改为**独立可缓存文件**，不再整包内联。
//   - inlineStylesheets: 'never' → Tailwind/daisyUI 编译结果落成 dist/assets/panel.<hash>.css；
//   - build.assets: 'assets' → 资源前缀就是 /assets/（Vite 默认的 /_astro/ 无对应静态路由）。
//   gateway 的静态路由已加入 /assets 前缀（扩展名仍只放行 .css/.js），并对命中的产物发
//   immutable 长缓存 —— 产物名带内容哈希，升级即换名，不会吃到旧缓存。
export default defineConfig({
  build: {
    format: 'file',
    assets: 'assets',
    inlineStylesheets: 'never',
  },
  compressHTML: false,
  vite: {
    plugins: [tailwindcss()],
  },
});
