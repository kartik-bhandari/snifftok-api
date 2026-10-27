/**
 * src/lib/mailer.js
 * Resend-powered email sender.
 *
 * Required env var:
 *   RESEND_API_KEY  — from resend.com dashboard
 *   RESEND_FROM     — verified sender, e.g. "Snifftok <noreply@snifftok.com>"
 *                     (use "onboarding@resend.dev" on the free tier before domain verification)
 */

import { Resend } from 'resend'

let _resend = null

function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY
    if (!key) throw new Error('RESEND_API_KEY is not set.')
    _resend = new Resend(key)
  }
  return _resend
}

const FROM = process.env.RESEND_FROM ?? 'Snifftok <onboarding@resend.dev>'

export async function sendOtpEmail(email, code) {
  const { error } = await getResend().emails.send({
    from:    FROM,
    to:      email,
    subject: `${code} — Your Snifftok sign-in code`,
    text: [
      `Your Snifftok sign-in code is: ${code}`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request this, you can safely ignore this email.',
      '',
      '— The Snifftok Team',
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Snifftok Sign-In Code</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
          <tr>
            <td align="center" style="padding:32px 32px 0">
              <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:0.12em;color:#0A0A0A">snifftok</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px">
              <p style="margin:0 0 8px;font-size:15px;color:#0A0A0A;font-weight:600">Your sign-in code</p>
              <p style="margin:0 0 24px;font-size:13px;color:#666666;line-height:1.5">
                Use the code below to sign in to your Snifftok account.
                It expires in <strong>10 minutes</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 24px">
              <div style="background:#F5F5F5;border-radius:12px;padding:20px 32px;display:inline-block">
                <p style="margin:0;font-size:36px;font-weight:700;letter-spacing:0.25em;color:#0A0A0A;font-family:monospace">${code}</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.5">
                If you did not request this code, you can safely ignore this email —
                someone may have entered your address by mistake.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  })

  if (error) {
    throw new Error(`Resend error: ${error.message}`)
  }
}
