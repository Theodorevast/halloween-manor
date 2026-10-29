/**
 * 构建期常量（vite.config.ts 的 define）：联名皮肤（config/character.ts 的 COLLAB_SPECS）能不能进访客轮换。
 * 开发服务器、COLLAB=1 构建时为 true，默认构建为 false（授权确认之前公开的构建里不能有联名的东西）；跑测试时为 true（vitest.config.ts）
 */
declare const __COLLAB__: boolean;
