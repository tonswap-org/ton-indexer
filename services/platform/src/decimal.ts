import { Decimal as DecimalConstructor } from 'decimal.js';
/** Retain headroom for atomic token quantities and reciprocal conversion rates. */
export const Decimal = DecimalConstructor.clone({ precision: 80 });
