import { Resend } from "resend";
import nodemailer from "nodemailer";

const resend = new Resend(process.env.RESEND_API_KEY);

const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || "TradePro <onboarding@resend.dev>";

let transporter: nodemailer.Transporter | null = null;
if (smtpHost && smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
  console.log(`[Email] SMTP transporter initialized with host: ${smtpHost}`);
}

export const sendOtpEmail = async (to: string, otp: string): Promise<void> => {
  console.log(`[OTP] Generated Code for ${to}: ${otp}`);

  const emailHtml = `
      <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
        <div style="height: 4px; background: linear-gradient(90deg, #047857, #10b981);"></div>
        <div style="padding: 32px;">
          <div style="margin-bottom: 24px;">
            <h1 style="margin: 0 0 4px; font-size: 20px; font-weight: 900; color: #0f172a;">TradePro</h1>
            <p style="margin: 0; font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Trading Analytics Suite</p>
          </div>

          <h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 800; color: #0f172a;">Verify your email</h2>
          <p style="margin: 0 0 28px; font-size: 14px; color: #64748b; line-height: 1.6;">
            Enter this code to complete your registration. It expires in <strong>10 minutes</strong>.
          </p>

          <div style="background: #f8fafc; border: 2px dashed #e2e8f0; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px;">
            <p style="margin: 0 0 8px; font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em;">Verification Code</p>
            <p style="margin: 0; font-size: 42px; font-weight: 900; color: #047857; letter-spacing: 0.15em; font-family: 'Courier New', monospace;">${otp}</p>
          </div>

          <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      </div>
    `;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: smtpFrom,
        to,
        subject: "Your TradePro Verification Code",
        html: emailHtml,
      });
      console.log(`[Email] OTP sent successfully to ${to} via SMTP`);
    } catch (smtpErr) {
      console.error(`[Email] Failed sending via SMTP:`, smtpErr);
      throw smtpErr;
    }
  } else {
    const { error } = await resend.emails.send({
      from: smtpFrom,
      to,
      subject: "Your TradePro Verification Code",
      html: emailHtml,
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
    console.log(`[Email] OTP sent successfully to ${to} via Resend`);
  }
};
