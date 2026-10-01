import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | undefined;

function getTransporter(): nodemailer.Transporter {
  if (transporter) {
    return transporter;
  }

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) {
    throw new Error("EMAIL_USER and EMAIL_PASS are required");
  }

  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || (host ? 587 : 465));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid port");
  }

  transporter = nodemailer.createTransport({
    ...(host
      ? {
          host,
          port,
          secure: process.env.SMTP_SECURE === "true" || (!process.env.SMTP_SECURE && port === 465),
        }
      : { service: process.env.EMAIL_SERVICE || "gmail" }),
    auth: { user, pass },
  });

  return transporter;
}

export function getEmailErrorDetails(error: unknown) {
  const typed = error as { code?: string; responseCode?: number; command?: string };
  return {
    code: typed?.code,
    responseCode: typed?.responseCode,
    command: typed?.command,
  };
}

export async function verifyEmailTransport(): Promise<void> {
  await getTransporter().verify();
}

export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  const mailer = getTransporter();
  await mailer.verify();
  await mailer.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: "رمز التحقق - T-SMART V7",
    text: `رمز التحقق الخاص بك هو: ${otp}\nصلاحية الرمز 10 دقائق.`,
  });
}