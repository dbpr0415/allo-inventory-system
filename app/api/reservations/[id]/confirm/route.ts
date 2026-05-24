import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DistributedLock } from "@/lib/redis";
import { addMinutes } from "date-fns";

/**
 * Handle idempotency for confirm requests
 */
async function handleIdempotency(
  idempotencyKey: string,
  requestPath: string
): Promise<NextResponse | null> {
  const existingRequest = await prisma.idempotencyKey.findUnique({
    where: { key: idempotencyKey },
  });

  if (existingRequest) {
    return NextResponse.json(existingRequest.response, {
      status: existingRequest.statusCode,
      headers: {
        "X-Idempotency-Replay": "true",
      },
    });
  }

  return null;
}

/**
 * Store idempotency response
 */
async function storeIdempotencyResponse(
  idempotencyKey: string,
  requestPath: string,
  requestBody: unknown,
  response: unknown,
  statusCode: number
): Promise<void> {
  const expiresAt = addMinutes(new Date(), 60 * 24); // 24 hours

  await prisma.idempotencyKey.create({
    data: {
      key: idempotencyKey,
      requestPath,
      requestBody: requestBody as any,
      response: response as any,
      statusCode,
      expiresAt,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Handle idempotency
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (idempotencyKey) {
      const cachedResponse = await handleIdempotency(
        idempotencyKey,
        `/api/reservations/${id}/confirm`
      );
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // Fetch reservation first to get product and warehouse IDs for lock
    const existingReservation = await prisma.reservation.findUnique({
      where: { id },
    });

    if (!existingReservation) {
      const response = { error: "Reservation not found" };
      if (idempotencyKey) {
        await storeIdempotencyResponse(
          idempotencyKey,
          `/api/reservations/${id}/confirm`,
          {},
          response,
          404
        );
      }
      return NextResponse.json(response, { status: 404 });
    }

    const lockKey = `reservation:${existingReservation.productId}:${existingReservation.warehouseId}`;

    // Execute confirmation logic with distributed lock
    const result = await DistributedLock.withLock(lockKey, async () => {
      const reservation = await prisma.reservation.findUnique({
        where: { id },
        include: {
          product: true,
          warehouse: true,
        },
      });

      if (!reservation) {
        return {
          success: false,
          error: "Reservation not found",
          statusCode: 404,
        };
      }

      // Check if reservation has already been processed
      if (reservation.status === "CONFIRMED") {
        return {
          success: true,
          data: reservation,
          statusCode: 200,
        };
      }

      if (reservation.status === "RELEASED" || reservation.status === "EXPIRED") {
        return {
          success: false,
          error: "Reservation has already been released or expired",
          statusCode: 410,
        };
      }

      // Check if reservation has expired
      if (new Date() > new Date(reservation.expiresAt)) {
        return {
          success: false,
          error: "Reservation has expired",
          statusCode: 410,
        };
      }

      // Update reservation status and decrement reserved units, increment total units decrease
      const [updatedReservation] = await prisma.$transaction([
        prisma.reservation.update({
          where: { id },
          data: {
            status: "CONFIRMED",
          },
          include: {
            product: true,
            warehouse: true,
          },
        }),
        prisma.stock.update({
          where: {
            productId_warehouseId: {
              productId: reservation.productId,
              warehouseId: reservation.warehouseId,
            },
          },
          data: {
            totalUnits: {
              decrement: reservation.quantity,
            },
            reservedUnits: {
              decrement: reservation.quantity,
            },
          },
        }),
      ]);

      return {
        success: true,
        data: updatedReservation,
        statusCode: 200,
      };
    });

    if (!result.success) {
      const response = { error: result.error };
      if (idempotencyKey) {
        await storeIdempotencyResponse(
          idempotencyKey,
          `/api/reservations/${id}/confirm`,
          {},
          response,
          result.statusCode
        );
      }
      return NextResponse.json(response, { status: result.statusCode });
    }

    const responseData = { reservation: result.data };
    if (idempotencyKey) {
      await storeIdempotencyResponse(
        idempotencyKey,
        `/api/reservations/${id}/confirm`,
        {},
        responseData,
        result.statusCode
      );
    }

    return NextResponse.json(responseData, { status: result.statusCode });
  } catch (error) {
    console.error("Error confirming reservation:", error);

    if (error instanceof Error && error.message === "Failed to acquire lock") {
      return NextResponse.json(
        { error: "System is busy, please try again" },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: "Failed to confirm reservation" },
      { status: 500 }
    );
  }
}
