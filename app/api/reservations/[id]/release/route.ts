import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DistributedLock } from "@/lib/redis";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Fetch reservation first to get product and warehouse IDs for lock
    const existingReservation = await prisma.reservation.findUnique({
      where: { id },
    });

    if (!existingReservation) {
      return NextResponse.json(
        { error: "Reservation not found" },
        { status: 404 }
      );
    }

    const lockKey = `reservation:${existingReservation.productId}:${existingReservation.warehouseId}`;

    // Execute release logic with distributed lock
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

      // Check if reservation has already been released
      if (reservation.status === "RELEASED" || reservation.status === "EXPIRED") {
        return {
          success: true,
          data: reservation,
          statusCode: 200,
        };
      }

      // Check if reservation is already confirmed (cannot release confirmed reservations)
      if (reservation.status === "CONFIRMED") {
        return {
          success: false,
          error: "Cannot release a confirmed reservation",
          statusCode: 400,
        };
      }

      // Update reservation status and decrement reserved units
      const [updatedReservation] = await prisma.$transaction([
        prisma.reservation.update({
          where: { id },
          data: {
            status: "RELEASED",
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
      return NextResponse.json(
        { error: result.error },
        { status: result.statusCode }
      );
    }

    return NextResponse.json(
      { reservation: result.data },
      { status: result.statusCode }
    );
  } catch (error) {
    console.error("Error releasing reservation:", error);

    if (error instanceof Error && error.message === "Failed to acquire lock") {
      return NextResponse.json(
        { error: "System is busy, please try again" },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: "Failed to release reservation" },
      { status: 500 }
    );
  }
}
