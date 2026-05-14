import React from 'react'
import ReactECharts from 'echarts-for-react'

interface BarChartProps {
  data: { name: string; value: number }[]
  height?: number
  color?: string
  title?: string
  yAxisLabel?: string
}

const BarChart: React.FC<BarChartProps> = ({
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
      axisPointer: { type: 'shadow' },
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: data.map((item) => item.name),
      axisLabel: { rotate: 30 },
    },
    yAxis: {
      type: 'value',
      name: yAxisLabel,
      nameTextStyle: { color: '#8c8c8c' },
    },
    series: [
      {
        name: yAxisLabel || 'Value',
        type: 'bar',
        barWidth: '60%',
        itemStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: color },
              { offset: 1, color: color + '80' },
            ],
          },
          borderRadius: [4, 4, 0, 0],
        },
        data: data.map((item) => item.value),
      },
    ],
  }

  return <ReactECharts option={option} style={{ height }} />
}

export default BarChart