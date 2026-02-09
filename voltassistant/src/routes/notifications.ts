/**
 * Notification Routes
 * REST API for notification management
 */

import { Router, Request, Response } from 'express'
import {
  configureHA,
  configureTelegram,
  configureDiscord,
  configureEscalation,
  handleWebhookUpdate,
  handleInteraction,
  getEscalatingAlerts,
  acknowledgeEscalatingAlert,
  resolveEscalatingAlert,
  getEscalationStats,
  processEscalations,
  notifyBatteryStatus,
  notifyPriceAlert,
  notifyCriticalAlert,
} from '../notifications'

const router = Router()

// ============== Configuration Endpoints ==============

/**
 * POST /notifications/config/ha
 * Configure Home Assistant integration
 */
router.post('/config/ha', async (req: Request, res: Response) => {
  try {
    const { url, token } = req.body

    if (!url || !token) {
      return res.status(400).json({ error: 'url and token are required' })
    }

    configureHA(url, token)
    res.json({ success: true, message: 'Home Assistant configured' })
  } catch (error) {
    console.error('HA config error:', error)
    res.status(500).json({ error: 'Failed to configure Home Assistant' })
  }
})

/**
 * POST /notifications/config/telegram
 * Configure Telegram bot
 */
router.post('/config/telegram', async (req: Request, res: Response) => {
  try {
    const { botToken, chatIds, adminChatId, parseMode } = req.body

    if (!botToken || !chatIds) {
      return res.status(400).json({ error: 'botToken and chatIds are required' })
    }

    configureTelegram({ botToken, chatIds, adminChatId, parseMode })
    res.json({ success: true, message: 'Telegram configured' })
  } catch (error) {
    console.error('Telegram config error:', error)
    res.status(500).json({ error: 'Failed to configure Telegram' })
  }
})

/**
 * POST /notifications/config/discord
 * Configure Discord integration
 */
router.post('/config/discord', async (req: Request, res: Response) => {
  try {
    const { webhookUrl, botToken, channelId, guildId, adminRoleId } = req.body

    if (!webhookUrl && !botToken) {
      return res.status(400).json({ error: 'webhookUrl or botToken is required' })
    }

    configureDiscord({ webhookUrl, botToken, channelId, guildId, adminRoleId })
    res.json({ success: true, message: 'Discord configured' })
  } catch (error) {
    console.error('Discord config error:', error)
    res.status(500).json({ error: 'Failed to configure Discord' })
  }
})

/**
 * POST /notifications/config/escalation
 * Configure escalation policies
 */
router.post('/config/escalation', async (req: Request, res: Response) => {
  try {
    const { policies, escalationIntervalMinutes, maxEscalations, quietHours, contacts } = req.body

    configureEscalation({
      policies,
      escalationIntervalMinutes,
      maxEscalations,
      quietHours,
      contacts,
    })

    res.json({ success: true, message: 'Escalation configured' })
  } catch (error) {
    console.error('Escalation config error:', error)
    res.status(500).json({ error: 'Failed to configure escalation' })
  }
})

// ============== Webhook Endpoints ==============

/**
 * POST /notifications/webhooks/telegram
 * Telegram bot webhook handler
 */
router.post('/webhooks/telegram', async (req: Request, res: Response) => {
  try {
    await handleWebhookUpdate(req.body)
    res.sendStatus(200)
  } catch (error) {
    console.error('Telegram webhook error:', error)
    res.sendStatus(200) // Always respond 200 to Telegram
  }
})

/**
 * POST /notifications/webhooks/discord
 * Discord interactions webhook
 */
router.post('/webhooks/discord', async (req: Request, res: Response) => {
  try {
    // Discord requires immediate verification
    if (req.body.type === 1) {
      return res.json({ type: 1 })
    }

    const response = await handleInteraction(req.body)

    if (response) {
      res.json({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: response,
      })
    } else {
      res.json({
        type: 6, // DEFERRED_UPDATE_MESSAGE
      })
    }
  } catch (error) {
    console.error('Discord webhook error:', error)
    res.status(500).json({ error: 'Interaction failed' })
  }
})

// ============== Alert Management ==============

/**
 * GET /notifications/alerts
 * Get active escalating alerts
 */
router.get('/alerts', async (req: Request, res: Response) => {
  try {
    const unacknowledgedOnly = req.query.unacknowledged === 'true'
    const severity = req.query.severity as any

    const alerts = getEscalatingAlerts({ unacknowledgedOnly, severity })
    const stats = getEscalationStats()

    res.json({ alerts, stats })
  } catch (error) {
    console.error('Get alerts error:', error)
    res.status(500).json({ error: 'Failed to get alerts' })
  }
})

/**
 * POST /notifications/alerts/:id/acknowledge
 * Acknowledge an alert
 */
router.post('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { acknowledgedBy } = req.body

    const success = acknowledgeEscalatingAlert(id, acknowledgedBy || 'api')

    if (!success) {
      return res.status(404).json({ error: 'Alert not found' })
    }

    res.json({ success: true, message: 'Alert acknowledged' })
  } catch (error) {
    console.error('Acknowledge error:', error)
    res.status(500).json({ error: 'Failed to acknowledge alert' })
  }
})

/**
 * POST /notifications/alerts/:id/resolve
 * Resolve an alert
 */
router.post('/alerts/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { resolvedBy } = req.body

    const success = resolveEscalatingAlert(id, resolvedBy)

    if (!success) {
      return res.status(404).json({ error: 'Alert not found' })
    }

    res.json({ success: true, message: 'Alert resolved' })
  } catch (error) {
    console.error('Resolve error:', error)
    res.status(500).json({ error: 'Failed to resolve alert' })
  }
})

/**
 * POST /notifications/alerts/process
 * Manually trigger escalation processing
 */
router.post('/alerts/process', async (req: Request, res: Response) => {
  try {
    const escalated = await processEscalations()
    res.json({ success: true, escalated })
  } catch (error) {
    console.error('Process escalations error:', error)
    res.status(500).json({ error: 'Failed to process escalations' })
  }
})

// ============== Send Notifications ==============

/**
 * POST /notifications/send/battery
 * Send battery status notification
 */
router.post('/send/battery', async (req: Request, res: Response) => {
  try {
    const { soc, power, temp, mode, trend, channels } = req.body

    if (soc === undefined) {
      return res.status(400).json({ error: 'soc is required' })
    }

    await notifyBatteryStatus(
      { soc, power: power || 0, temp: temp || 0, mode: mode || 'Unknown', trend },
      { channels }
    )

    res.json({ success: true, message: 'Battery notification sent' })
  } catch (error) {
    console.error('Battery notification error:', error)
    res.status(500).json({ error: 'Failed to send notification' })
  }
})

/**
 * POST /notifications/send/price
 * Send price alert notification
 */
router.post('/send/price', async (req: Request, res: Response) => {
  try {
    const { price, avgPrice, minPrice, maxPrice, recommendation, cheapHours, channels } = req.body

    if (price === undefined || avgPrice === undefined) {
      return res.status(400).json({ error: 'price and avgPrice are required' })
    }

    await notifyPriceAlert(
      { price, avgPrice, minPrice, maxPrice, recommendation: recommendation || '', cheapHours },
      { channels }
    )

    res.json({ success: true, message: 'Price notification sent' })
  } catch (error) {
    console.error('Price notification error:', error)
    res.status(500).json({ error: 'Failed to send notification' })
  }
})

/**
 * POST /notifications/send/alert
 * Send critical alert
 */
router.post('/send/alert', async (req: Request, res: Response) => {
  try {
    const { type, message, priority, escalate, channels } = req.body

    if (!type || !message) {
      return res.status(400).json({ error: 'type and message are required' })
    }

    await notifyCriticalAlert(type, message, { priority, escalate, channels })

    res.json({ success: true, message: 'Alert sent' })
  } catch (error) {
    console.error('Alert notification error:', error)
    res.status(500).json({ error: 'Failed to send alert' })
  }
})

/**
 * GET /notifications/stats
 * Get notification statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = getEscalationStats()
    res.json(stats)
  } catch (error) {
    console.error('Stats error:', error)
    res.status(500).json({ error: 'Failed to get stats' })
  }
})

export default router
