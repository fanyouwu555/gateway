import React from 'react'
import ReactECharts from 'echarts-for-react'
import type { PieChartDataItem } from '@/types'

interface PieChartProps {
  data: PieChartDataItem[]
  height?: number
  colors?: string[]
  title?: string
}

const defaultColors = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2']

const PieChart: React.FC<PieChartProps> = ({
  data,
  height = 300,
  colors = defaultColors,
  title,
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
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
    },
    legend: {
      orient: 'vertical',
      right: 10,
      top: 'center',
    },
    series: [
      {
        name: '分布',
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['40%', '50%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 10,
          borderColor: '#fff',
          borderWidth: 2,
        },
        label: {
          show: false,
          position: 'center',
        },
        emphasis: {
          label: {
            show: true,
            fontSize: 16,
            fontWeight: 'bold',
          },
        },
        labelLine: {
          show: false,
        },
        data: data.map((item, index) => ({
          ...item,
          itemStyle: { color: colors[index % colors.length] },
        })),
      },
    ],
  }

  return <ReactECharts option={option} style={{ height }} />
}

export default PieChart