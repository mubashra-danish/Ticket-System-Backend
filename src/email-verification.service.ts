import {
  BadRequestException,
  Injectable,
 HttpException,
  HttpStatus,
} from "@nestjs/common";
import { createHash, randomInt } from "crypto";

type VerificationRecord = {
  email: string;
  otpHash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  verified: boolean;
};

@Injectable()
export class EmailVerificationService {
  private readonly records = new Map<string, VerificationRecord>();

  private readonly OTP_TTL = 10 * 60 * 1000; // 10 minutes
  private readonly RESEND_COOLDOWN = 60 * 1000; // 60 seconds
  private readonly MAX_ATTEMPTS = 5;

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private hashOtp(email: string, otp: string) {
    return createHash("sha256")
      .update(`${email}:${otp}`)
      .digest("hex");
  }

  async send(email: string) {
    const normalizedEmail = this.normalizeEmail(email);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException("Enter a valid email address.");
    }

    const existing = this.records.get(normalizedEmail);
    const now = Date.now();

    if (
      existing &&
      now - existing.lastSentAt < this.RESEND_COOLDOWN
    ) {
      const remaining = Math.ceil(
        (this.RESEND_COOLDOWN -
          (now - existing.lastSentAt)) /
          1000,
      );

      throw new HttpException(
  `Please wait ${remaining} seconds before requesting another code.`,
  HttpStatus.TOO_MANY_REQUESTS,
);
    }

    const otp = randomInt(100000, 1000000).toString();

    const record: VerificationRecord = {
      email: normalizedEmail,
      otpHash: this.hashOtp(normalizedEmail, otp),
      expiresAt: now + this.OTP_TTL,
      attempts: 0,
      lastSentAt: now,
      verified: false,
    };

    this.records.set(normalizedEmail, record);

    // Temporary development version.
    // Replace this with your existing EmailService below.
    console.log(
      `[EmailVerification] OTP for ${normalizedEmail}: ${otp}`,
    );

    return {
      message: "Verification code sent.",
      expiresIn: this.OTP_TTL / 1000,
    };
  }

  verify(email: string, otp: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const record = this.records.get(normalizedEmail);

    if (!record) {
      throw new BadRequestException(
        "No verification code was requested for this email.",
      );
    }

    if (record.verified) {
      return {
        verified: true,
        message: "Email is already verified.",
      };
    }

    if (Date.now() > record.expiresAt) {
      this.records.delete(normalizedEmail);

      throw new BadRequestException(
        "This verification code has expired. Please request a new code.",
      );
    }

    if (!/^\d{6}$/.test(otp)) {
      throw new BadRequestException(
        "Enter the 6-digit verification code.",
      );
    }

    if (record.attempts >= this.MAX_ATTEMPTS) {
      this.records.delete(normalizedEmail);

     throw new HttpException(
  "Too many incorrect attempts. Please request a new code.",
  HttpStatus.TOO_MANY_REQUESTS,
);
    }
    record.attempts++;

    const suppliedHash = this.hashOtp(
      normalizedEmail,
      otp,
    );

    if (suppliedHash !== record.otpHash) {
      throw new BadRequestException(
        `Incorrect verification code. ${
          this.MAX_ATTEMPTS - record.attempts
        } attempts remaining.`,
      );
    }

    record.verified = true;

    return {
      verified: true,
      email: normalizedEmail,
      message: "Email verified successfully.",
    };
  }

  isVerified(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    return this.records.get(normalizedEmail)?.verified === true;
  }
}