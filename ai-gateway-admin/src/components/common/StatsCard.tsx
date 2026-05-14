import React from 'react'
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons'

interface StatsCardProps {
  title: string
  value: string | number
  trend?: number
  suffix?: string
  prefix?: React.ReactNode
}

const StatsCard: React.FC<StatsCardProps> = ({ title, value, trend, suffix, prefix }) => {
  const isUp = trend && trend > 0
  const isDown = trend && trend < 0
  const trendText = trend ? (trend > 0 ? `+${trend.toFixed(2)}%` : `${trend.toFixed(2)}%`) : ''

  return (
    <div className="stats-card">
      <div className="title">{title}</div>
      <div className="value" style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        {prefix}
        <span>{value}</span>
        {suffix && <span style={{ fontSize: 14, color: '#8c8c8c' }}>{suffix}</span>}
      </div>
      {trend !== undefined && (
        <div className={`trend ${isUp ? 'up' : isDown ? 'down' : ''}`}>
          {isUp && <ArrowUpOutlined />}
          {isDown && <ArrowDownOutlined />}
          <span style={{ marginLeft: 4 }}>{trendText}</span>
          <span style={{ marginLeft: 4, color: '#8c8c8c' }}>较上周</span>
        </div>
      )}
    </div>
  )
}

export default StatsCard