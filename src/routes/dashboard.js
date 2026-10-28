/**
 * src/routes/dashboard.js
 * Admin dashboard data.
 *
 *   GET /api/admin/dashboard/summary?period=today|7d|30d
 *   GET /api/admin/dashboard/attention
 *
 * MONEY: paise. Profit is admin-only — netProfit is null for staff.
 * Days are bucketed in IST (UTC+5:30, no DST).
 */

import { Router } from 'express'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'
import { getUnitCosts } from '../lib/orderCosts.js'

export const dashboardRouter = Router()

const HOUR       = 60 * 60 * 1000
const DAY        = 24 * HOUR
const IST_OFFSET = 330 * 60 * 1000

const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 }

/** Midnight IST (as a UTC Date) of the day containing `date` */
function istDayStart(date) {
  return new Date(Math.floor((date.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET)
}

/** Bucket key in IST — "2026-10-28" (day) or "2026-10-28T14" (hour) */
function istKey(date, bucket) {
  const iso = new Date(date.getTime() + IST_OFFSET).toISOString()
  return bucket === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10)
}

/** Totals for a list of orders. `costOf(item)` returns paise or undefined. */
function totals(orders, costOf) {
  let revenue = 0, netProfit = 0, unitsSold = 0, missingCost = 0
  for (const o of orders) {
    revenue += o.total
    for (const item of o.items) {
      unitsSold += item.quantity
      const cost = costOf(item)
      if (cost == null) missingCost += 1
      else netProfit += item.lineTotal - cost * item.quantity
    }
  }
  const count = orders.length
  return {
    revenue,
    netProfit,
    orders: count,
    aov: count ? Math.round(revenue / count) : 0,
    unitsSold,
    missingCost,
  }
}

dashboardRouter.get('/summary', async (req, res) => {
  try {
    const period = PERIOD_DAYS[req.query.period] ? req.query.period : '7d'
    const days   = PERIOD_DAYS[period]
    const bucket = period === 'today' ? 'hour' : 'day'
    const isAdmin = req.user.role === 'admin'

    const now       = new Date()
    const start     = new Date(istDayStart(now).getTime() - (days - 1) * DAY)
    // Previous period: same length, ending at the same point in time — so
    // "today so far" is compared with "yesterday up to this time".
    const prevStart = new Date(start.getTime() - days * DAY)
    const prevEnd   = new Date(now.getTime() - days * DAY)

    const all = await Order.find({
      status:    { $ne: 'cancelled' },
      createdAt: { $gte: prevStart, $lte: now },
    })
      .select('total items createdAt channel')
      .lean()

    // Older orders have no unitCost snapshot — fall back to the current cost price
    const fallback = isAdmin
      ? await getUnitCosts(all.flatMap(o => o.items.filter(i => i.unitCost == null).map(i => i.sku)))
      : new Map()
    const costOf = (item) => item.unitCost ?? fallback.get(item.sku?.toUpperCase())

    const current  = all.filter(o => o.createdAt >= start)
    const previous = all.filter(o => o.createdAt >= prevStart && o.createdAt <= prevEnd)

    const cur  = totals(current, costOf)
    const prev = totals(previous, costOf)

    // ── Chart — every bucket present, zero-filled ────────────────────────────
    const chart = new Map()
    const step  = bucket === 'hour' ? HOUR : DAY
    for (let t = start.getTime(); t <= now.getTime(); t += step) {
      chart.set(istKey(new Date(t), bucket), { date: istKey(new Date(t), bucket), revenue: 0, netProfit: 0 })
    }

    // ── Channels + top products ──────────────────────────────────────────────
    const byChannel = { web: 0, whatsapp: 0, admin: 0 }
    const products  = new Map()

    for (const o of current) {
      byChannel[o.channel ?? 'web'] += 1

      const point = chart.get(istKey(o.createdAt, bucket))
      if (point) point.revenue += o.total

      for (const item of o.items) {
        const cost = costOf(item)
        if (point && cost != null) point.netProfit += item.lineTotal - cost * item.quantity

        const key = item.productId?.toString() ?? item.name
        const p = products.get(key) ?? {
          productId: item.productId?.toString() ?? null,
          name:      item.name,
          brand:     item.brand ?? null,
          image:     item.image ?? null,
          unitsSold: 0,
          revenue:   0,
        }
        p.unitsSold += item.quantity
        p.revenue   += item.lineTotal
        products.set(key, p)
      }
    }

    const topProducts = [...products.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)

    const hideProfit = (t) => ({ ...t, netProfit: isAdmin ? t.netProfit : null })
    const { missingCost, ...curTotals } = cur
    const { missingCost: _m, ...prevTotals } = prev // eslint-disable-line no-unused-vars

    res.json({
      period,
      bucket,
      ...hideProfit(curTotals),
      // Lines whose cost price couldn't be found — profit leaves them out
      profitMissingCost: isAdmin ? missingCost : 0,
      byChannel,
      chartData: [...chart.values()].map(p => ({ ...p, netProfit: isAdmin ? p.netProfit : null })),
      previous:  hideProfit(prevTotals),
      topProducts,
    })
  } catch (err) {
    console.error('[admin/dashboard] summary:', err)
    res.status(500).json({ message: 'Failed to load dashboard.' })
  }
})

dashboardRouter.get('/attention', async (_req, res) => {
  try {
    const [pending, lowStock] = await Promise.all([
      // Orders waiting to be confirmed — oldest first
      Order.find({ status: 'pending' })
        .sort({ createdAt: 1 })
        .limit(10)
        .select('orderNumber customer.name total createdAt')
        .lean(),

      // Active variants at or below their reorder level
      Product.aggregate([
        { $match: { isActive: true } },
        { $unwind: '$variants' },
        { $addFields: { available: { $subtract: ['$variants.stock', { $ifNull: ['$variants.reserved', 0] }] } } },
        { $match: { $expr: { $lte: ['$available', { $ifNull: ['$variants.reorderLevel', 3] }] } } },
        { $sort: { available: 1 } },
        { $limit: 10 },
        { $project: {
          name: 1, brand: 1,
          sku: '$variants.sku', type: '$variants.type', sizeMl: '$variants.sizeMl',
          reorderLevel: '$variants.reorderLevel', available: 1,
        } },
      ]),
    ])

    const items = [
      ...pending.map(o => ({
        type:         'order_pending',
        orderId:      o._id.toString(),
        orderNumber:  o.orderNumber,
        customerName: o.customer?.name,
        total:        o.total,
        createdAt:    o.createdAt,
        message:      'Waiting to be confirmed',
      })),
      ...lowStock.map(v => ({
        type:           'low_stock',
        productId:      v._id.toString(),
        sku:            v.sku,
        variantLabel:   `${v.name} ${v.sizeMl}ml${v.type === 'tester' ? ' Tester' : ''}`,
        availableStock: Math.max(0, v.available),
        reorderLevel:   v.reorderLevel ?? 3,
        message:        v.available <= 0 ? 'Out of stock' : `Only ${v.available} left`,
      })),
    ]

    res.json({ items })
  } catch (err) {
    console.error('[admin/dashboard] attention:', err)
    res.status(500).json({ message: 'Failed to load attention items.' })
  }
})
