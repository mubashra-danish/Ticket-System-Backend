import {
  Body,
  Controller,
  Post,
} from "@nestjs/common";
import { EmailVerificationService } from "./email-verification.service.js";

@Controller("api/email-verification")
export class EmailVerificationController {
  constructor(
    private readonly verification: EmailVerificationService,
  ) {}

  @Post("send")
  async send(
    @Body("email") email: unknown,
  ) {
    if (typeof email !== "string") {
      throw new Error("Email is required.");
    }

    return this.verification.send(email);
  }

  @Post("verify")
  verify(
    @Body("email") email: unknown,
    @Body("otp") otp: unknown,
  ) {
    if (typeof email !== "string") {
      throw new Error("Email is required.");
    }

    if (typeof otp !== "string") {
      throw new Error("Verification code is required.");
    }

    return this.verification.verify(email, otp);
  }
}