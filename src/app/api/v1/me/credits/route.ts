import { NextResponse } from "next/server";
import { CreditBalanceResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getUserCreditBalance } from "@/modules/credits/credits";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const balance = await getUserCreditBalance(user.id);
  return NextResponse.json(CreditBalanceResponse.parse({ balance: Number(balance) }));
});
