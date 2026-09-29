const crypto = require("crypto");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const otpSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

let mongoConnection;

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true, maxlength: 100 },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
  },
  { timestamps: true },
);

const otpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

const User = mongoose.models.User || mongoose.model("User", userSchema);
const OtpChallenge = mongoose.models.OtpChallenge || mongoose.model("OtpChallenge", otpSchema);

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashOtp(email, otp) {
  return crypto
    .createHmac("sha256", otpSecret)
    .update(`${email}:${otp}`)
    .digest("hex");
}

async function connectToMongo() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (!mongoConnection) {
    mongoConnection = mongoose.connect(process.env.MONGO_URI).catch((error) => {
      mongoConnection = undefined;
      throw error;
    });
  }

  await mongoConnection;
}

let mailer;

function getMailerErrorDetails(error) {
  return {
    code: error?.code,
    responseCode: error?.responseCode,
    command: error?.command,
  };
}

function createMailer() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

async function verifyEmailTransport() {
  const transport = createMailer();
  await transport.verify();
}

function registerAuthRoutes(app) {
  app.post("/api/send-otp", async (req, res) => {
    const email = normalizeEmail(req.body?.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "يرجى إدخال بريد إلكتروني صحيح" });
    }

    try {
      await connectToMongo();

      const existingChallenge = await OtpChallenge.findOne({ email }).lean();
      if (
        existingChallenge &&
        Date.now() - new Date(existingChallenge.lastSentAt).getTime() < OTP_RESEND_COOLDOWN_MS
      ) {
        return res.status(429).json({
          success: false,
          message: "انتظر دقيقة قبل طلب رمز جديد",
        });
      }

      const otp = crypto.randomInt(100000, 1000000).toString();
      const mailer = createMailer();
      await mailer.verify();
      await mailer.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: email,
        subject: "رمز التحقق",
        text: `رمز التحقق الخاص بك هو: ${otp}\nصلاحية الرمز 10 دقائق.`,
      });

      await OtpChallenge.findOneAndUpdate(
        { email },
        {
          email,
          codeHash: hashOtp(email, otp),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          lastSentAt: new Date(),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      return res.json({
        success: true,
        message: "تم إرسال رمز التحقق إلى بريدك الإلكتروني",
      });
    } catch (error) {
      console.error("OTP email delivery failed:", getMailerErrorDetails(error));
      return res.status(503).json({
        success: false,
        message: "تعذر إرسال رمز التحقق حالياً",
      });
    }
  });

  app.post("/api/register", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;

    if (!isValidEmail(email) || password.length < 8 || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "البريد وكلمة المرور ورمز التحقق غير صالحين",
      });
    }

    try {
      await connectToMongo();

      const challenge = await OtpChallenge.findOne({ email });
      if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({
          success: false,
          message: "رمز التحقق منتهي أو غير موجود",
        });
      }

      const expectedHash = hashOtp(email, otp);
      const providedHash = Buffer.from(expectedHash, "hex");
      const storedHash = Buffer.from(challenge.codeHash, "hex");
      if (
        providedHash.length !== storedHash.length ||
        !crypto.timingSafeEqual(providedHash, storedHash)
      ) {
        return res.status(400).json({
          success: false,
          message: "رمز التحقق غير صحيح",
        });
      }

      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = (await scrypt(password, salt, 64)).toString("hex");

      await User.create({
        email,
        name,
        passwordHash,
        passwordSalt: salt,
      });
      await OtpChallenge.deleteOne({ email });

      return res.status(201).json({
        success: true,
        message: "تم إنشاء الحساب بنجاح",
      });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "هذا البريد الإلكتروني مسجل بالفعل",
        });
      }

      console.error("Registration failed:", error.message);
      return res.status(503).json({
        success: false,
        message: "تعذر إنشاء الحساب حالياً",
      });
    }
  });
}

module.exports = { registerAuthRoutes, verifyEmailTransport };