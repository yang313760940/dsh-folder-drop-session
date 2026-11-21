/**
 * dsh Host Loader 入口。
 * 这是纯客户端插件；Host 加载此入口后，dsh-client-modules 根据
 * package.json 的 dsh.client 与 ./client 导出加载浏览器半侧。
 * 不注册自造的 RPC，不修改工作目录、宿主安装或进程全局 cwd。
 */
export function apply() {}
