"use client";

import { getAccessToken } from "@privy-io/react-auth";

export async function authHeaders() {
  const token = await getAccessToken();
  if (!token) throw new Error("Your session expired. Sign in again.");
  return { "privy-id-token": token };
}
