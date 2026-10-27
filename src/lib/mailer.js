/**
 * src/lib/mailer.js
 * Thin nodemailer wrapper.
 *
 * Required env vars (set in .env / Render dashboard):
 *   SMTP_HOST   — e.g. smtp.gmail.com  (or smtp.sendgrid.net, etc.)
 *   SMTP_PORT   — 587 (STARTTLS) or 465 (SSL)
 *   SMTP_USER   — your sending email address / API login
 *   SMTP_PASS   — App Password (Gmail) or API key
 *   SMTP_FROM   — display name + address, e.g. "Snifftok <noreply@snifftok.com>"
 *
 * Gmail quick-start:
 *   1. Enable 2-Step Verification on the Gmail account.
 *   2. Go to https://myaccount.google.com/apppasswords
 *   3. Generate an App Password for "Mail".
 *   4. Set SMTP_USER=you@gmail.com  SMTP_PASS=<16-char app password>
 *      SMTP_HOST=smtp.gmail.com  SMTP_PORT=587
 */

import nodemailer from 'nodemailer'

/** Lazy-initialised transport — created once on first use */
let _transport = null

function getTransport() {
  if (_transport) return _transport

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP credentials are not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env')
  }

  _transport = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,   // true for 465, false for 587/25
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })

  return _transport
}

/**
 * Send the 6-digit OTP to the user's email address.
 * Throws on SMTP error — caller should handle gracefully.
 */
export async function sendOtpEmail(email, code) {
  const from = process.env.SMTP_FROM ?? `Snifftok <${process.env.SMTP_USER}>`

  await getTransport().sendMail({
    from,
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
          <!-- Header -->
          <tr>
            <td align="center" style="padding:32px 32px 0">
              <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:0.12em;color:#0A0A0A">snifftok</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:24px 32px 8px">
              <p style="margin:0 0 8px;font-size:15px;color:#0A0A0A;font-weight:600">Your sign-in code</p>
              <p style="margin:0 0 24px;font-size:13px;color:#666666;line-height:1.5">
                Use the code below to sign in to your Snifftok account.
                It expires in <strong>10 minutes</strong>.
              </p>
            </td>
          </tr>
          <!-- Code box -->
          <tr>
            <td align="center" style="padding:0 32px 24px">
              <div style="background:#F5F5F5;border-radius:12px;padding:20px 32px;display:inline-block">
                <p style="margin:0;font-size:36px;font-weight:700;letter-spacing:0.25em;color:#0A0A0A;font-family:monospace">${code}</p>
              </div>
            </td>
          </tr>
          <!-- Footer -->
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
}
