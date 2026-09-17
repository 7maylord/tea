import { Prisma } from '@prisma/client';

export async function upsertThread(
  tx: Prisma.TransactionClient,
  chainId: number,
  firstUserId: string,
  secondUserId: string,
) {
  const [lowerUserId, upperUserId] = [firstUserId, secondUserId].sort();
  return tx.thread.upsert({
    where: {
      chainId_lowerUserId_upperUserId: { chainId, lowerUserId, upperUserId },
    },
    create: { chainId, lowerUserId, upperUserId },
    update: {},
    select: { id: true },
  });
}
