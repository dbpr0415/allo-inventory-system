import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    // Verify the request is from Vercel Cron
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();

    // Find all pending reservations that have expired
    const expiredReservations = await prisma.reservation.findMany({
      where: {
        status: "PENDING",
        expiresAt: {
          lte: now,
        },
      },
    });

    if (expiredReservations.length === 0) {
      return NextResponse.json({
        message: "No expired reservations found",
        count: 0,
      });
    }

    // Group by product-warehouse for batch processing
    const stockUpdates = new Map<
      string,
      { productId: string; warehouseId: string; quantity: number }
    >();

    for (const reservation of expiredReservations) {
      const key = `${reservation.productId}:${reservation.warehouseId}`;
      const existing = stockUpdates.get(key);

      if (existing) {
        existing.quantity += reservation.quantity;
      } else {
        stockUpdates.set(key, {
          productId: reservation.productId,
          warehouseId: reservation.warehouseId,
          quantity: reservation.quantity,
        });
      }
    }

    // Execute updates in a transaction
    await prisma.$transaction(async (tx) => {
      // Update all expired reservations to EXPIRED status
      await tx.reservation.updateMany({
        where: {
          id: {
            in: expiredReservations.map((r) => r.id),
          },
        },
        data: {
          status: "EXPIRED",
        },
      });

      // Release reserved units for each product-warehouse combination
      for (const { productId, warehouseId, quantity } of stockUpdates.values()) {
        await tx.stock.update({
          where: {
            productId_warehouseId: {
              productId,
              warehouseId,
            },
          },
          data: {
            reservedUnits: {
              decrement: quantity,
            },
          },
        });
      }
    });

    console.log(`Expired ${expiredReservations.length} reservations`);

    return NextResponse.json({
      message: "Expired reservations processed successfully",
      count: expiredReservations.length,
      reservationIds: expiredReservations.map((r) => r.id),
    });
  } catch (error) {
    console.error("Error expiring reservations:", error);
    return NextResponse.json(
      { error: "Failed to expire reservations" },
      { status: 500 }
    );
  }
}

// Also cleanup old idempotency keys
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();

    const deletedKeys = await prisma.idempotencyKey.deleteMany({
      where: {
        expiresAt: {
          lte: now,
        },
      },
    });

    return NextResponse.json({
      message: "Idempotency keys cleaned up",
      count: deletedKeys.count,
    });
  } catch (error) {
    console.error("Error cleaning idempotency keys:", error);
    return NextResponse.json(
      { error: "Failed to cleanup idempotency keys" },
      { status: 500 }
    );
  }
}
