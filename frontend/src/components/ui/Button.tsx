import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";

export type ButtonVariant = "primary" | "danger";
export type ButtonSize = "small";

interface Styling {
  /** Omit for the ordinary bordered button. */
  variant?: ButtonVariant;
  /** Omit for the standard height. */
  size?: ButtonSize;
}

/**
 * The variants are named rather than open, so `primary` and `danger` stay the
 * only two answers to "make this one stand out". An open className would let
 * the thirty-first button invent a thirty-first look.
 */
const classes = ({ variant, size }: Styling) =>
  ["btn", variant, size].filter(Boolean).join(" ");

/**
 * Defaults to type="button".
 *
 * A bare <button> inside a <form> submits it, which is the wrong default for
 * a button that removes an ingredient row. Submitting is the rarer intent, so
 * it is the one that has to be asked for.
 */
export function Button({
  variant,
  size,
  type = "button",
  ...rest
}: Styling & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={classes({ variant, size })} {...rest} />;
}

/** The same control when it navigates rather than acts. */
export function LinkButton({ variant, size, ...rest }: Styling & LinkProps) {
  return <Link className={classes({ variant, size })} {...rest} />;
}

/**
 * An icon-only button. `label` is required and becomes the accessible name -
 * there is no readable text to fall back on, so it cannot be optional.
 */
export function IconButton({
  label,
  ...rest
}: { label: string } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "className"
>) {
  return <button type="button" className="icon-btn" aria-label={label} {...rest} />;
}
