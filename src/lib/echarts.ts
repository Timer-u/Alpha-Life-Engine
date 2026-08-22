import type { EChartsOption } from 'echarts';

import ReactEChartsCore from 'echarts-for-react/lib/core';
import { LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
/**
 * ECharts 按需注册（打包瘦身：只引用项目实际用到的图表/组件/渲染器）。
 *
 * 组件统一从本模块取 `EChart`（echarts-for-react core + 已注册模块），
 * 不要直接 `import ReactECharts from 'echarts-for-react'`（那会打整包）。
 */
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export { echarts, ReactEChartsCore };
export type { EChartsOption };
