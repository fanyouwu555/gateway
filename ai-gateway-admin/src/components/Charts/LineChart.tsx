import React from 'react'
import ReactECharts from 'echarts-for-react'
import type { ChartDataItem } from '@/types'

interface LineChartProps {
  data: ChartDataItem[]
  height?: number
  color?: string
  title?: string
  yAxisLabel?: string
}

const LineChart: React.FC<LineChartProps> = ({
  data,
  height = 300,
  color = '#1890ff',
  title,
  yAxisLabel,
}) => {
  const option = {
    title: title
      ? {
          text: title,
          left: 'center',
          textStyle: { fontSize: 14, fontWeight: 'normal' },
        }
      : undefined,
    tooltip: {
      trigger: 'axis',
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: data.map((item) => item.time),
    },
    yAxis: {
      type: 'value',
      name: yAxisLabel,
      nameTextStyle: { color: '#8c8c8c' },
    },
    series: [
      {
        name: yAxisLabel || 'Value',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: color + '40' },
              { offset: 1, color: color + '05' },
            ],
          },
        },
        data: data.map((item) => item.value),
      },
    ],
  }

  return <ReactECharts option={option} style={{ height }} />
}

export default LineChart