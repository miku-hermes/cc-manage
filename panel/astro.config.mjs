import { defineConfig } from 'astro/config';

// B22：产物格式必须是 file —— Astro 默认的目录格式会把 /admin 输出成 admin/index.html，
// 与 gateway 现有的显式路由（/、/admin）对不上，还会引入尾斜杠 / 重定向。
// 这里保持与旧 public/*.html 一致的扁平产物：index.html / admin.html。
export default defineConfig({
  build: {
    format: 'file',
  },
  // B22：产物必须是源码 HTML 的逐字节副本（零视觉变化）。Astro 默认会压缩 HTML
  // （折叠空白 / 去掉结尾换行），这里关掉；页面根 <html is:raw> 保证 <style>/<script>/
  // SVG 自闭合标签等全部原样输出（不会被作用域化或重写成 data-astro-cid）。
  compressHTML: false,
});
