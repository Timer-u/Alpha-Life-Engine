

export async function sendOtpEmail(email: string, code: string, apiKey?: string): Promise<void> {
  if (!apiKey) {
    console.warn('[DEV] OTP:', code);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: 'no-reply@alpha-life.yourdomain.com',
      to: email,
      subject: '您的 Alpha-Life 登录验证码',
      html: `<p>您的验证码是 <strong>${code}</strong>，10分钟内有效。</p>`,
    }),
  });
}
