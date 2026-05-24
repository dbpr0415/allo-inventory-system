import { z } from "zod";

export const createReservationSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  warehouseId: z.string().min(1, "Warehouse ID is required"),
  quantity: z.number().int().positive("Quantity must be a positive integer"),
});

export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const confirmReservationSchema = z.object({
  id: z.string().min(1, "Reservation ID is required"),
});

export const releaseReservationSchema = z.object({
  id: z.string().min(1, "Reservation ID is required"),
});
