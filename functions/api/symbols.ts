// 全局跟踪的标的与名称映射（安全层 ETF + 进取层 ETF）
export const TRACKED_SYMBOLS = ['511360', '511880', '511990', '510300', '510500', '515080'];

export const SAFE_SYMBOLS = ['511360', '511880', '511990'];

export const SYMBOL_NAMES: Record<string, string> = {
  '511360': '海富通短融ETF',
  '511880': '银华日利',
  '511990': '华宝添益',
  '510300': '沪深300 ETF',
  '510500': '中证500 ETF',
  '515080': '中证红利 ETF',
};

export function symbolName(symbol: string): string {
  return SYMBOL_NAMES[symbol] ?? symbol;
}
