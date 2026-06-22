import type { Position } from '../types/api';

interface Props { positions: Position[]; }

export default function PositionsList({ positions }: Props) {
  const safePositions = positions.filter(p => p.layer === 'safe');
  const ambitionPositions = positions.filter(p => p.layer === 'ambition');

  const renderCard = (p: Position) => (
    <div key={p.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
      <div>
        <p className="font-medium text-gray-900">{p.symbol}</p>
        <p className="text-sm text-gray-500">{p.name}</p>
      </div>
      <div className="text-right">
        <p className="font-medium text-gray-900">{p.shares.toFixed(3)} 股</p>
        <p className="text-sm text-gray-500">均价 ¥{p.avg_price.toFixed(2)}</p>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-success-500" />安全层持仓
        </h3>
        {safePositions.length > 0 ? <div className="space-y-3">{safePositions.map(renderCard)}</div>
          : <p className="text-sm text-gray-400 text-center py-8">暂无持仓</p>}
      </div>
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary-500" />进取层持仓
        </h3>
        {ambitionPositions.length > 0 ? <div className="space-y-3">{ambitionPositions.map(renderCard)}</div>
          : <p className="text-sm text-gray-400 text-center py-8">暂无持仓</p>}
      </div>
    </div>
  );
}
