// 全局跟踪的标的与名称映射（安全层 ETF + 进取层指数）
export const TRACKED_SYMBOLS = ['511360', '511880', '000300', '000905', '000922'];

export const SAFE_SYMBOLS = ['511360', '511880'];

export const SYMBOL_NAMES: Record<string, string> = {
  '511360': '海富通短融ETF',
  '511880': '银华日利',
  '000300': '沪深300 (指数)',
  '000905': '中证500 (指数)',
  '000922': '中证红利 (指数)',
};

export function symbolName(symbol: string): string {
  return SYMBOL_NAMES[symbol] ?? symbol;
}
