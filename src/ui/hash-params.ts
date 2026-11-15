/** 地址栏 # 后面的参数（例如 #flow?kind=arrival&id=3 里的 kind、id）。 */
export const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
