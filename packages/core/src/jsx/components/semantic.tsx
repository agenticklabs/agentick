import React from "react";
import type { JSX } from "react";
import type { ComponentBaseProps } from "../jsx-types";

// Helper for createElement
const h = React.createElement;

/**
 * Semantic content primitives for expressive rendering.
 * These provide semantic meaning to renderers beyond plain text.
 */

interface BaseProps extends ComponentBaseProps {}

/**
 * Generic heading component
 */
export interface HeaderProps extends BaseProps {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: any;
}
export function Header(props: HeaderProps): JSX.Element {
  return h("Header", props);
}

/**
 * Heading level 1
 */
export interface H1Props extends BaseProps {
  children?: any;
}
export function H1(props: H1Props): JSX.Element {
  return h("H1", props);
}

/**
 * Heading level 2
 */
export interface H2Props extends BaseProps {
  children?: any;
}
export function H2(props: H2Props): JSX.Element {
  return h("H2", props);
}

/**
 * Heading level 3
 */
export interface H3Props extends BaseProps {
  children?: any;
}
export function H3(props: H3Props): JSX.Element {
  return h("H3", props);
}

/**
 * Paragraph component
 */
export interface ParagraphProps extends BaseProps {
  key?: string;
  children?: any;
}
export function Paragraph(props: ParagraphProps): JSX.Element {
  return h("Paragraph", props);
}

/**
 * List component
 *
 * @example
 * ```tsx
 * // List with title
 * <List title="Shopping List">
 *   <ListItem>Milk</ListItem>
 *   <ListItem>Bread</ListItem>
 * </List>
 *
 * // Ordered list
 * <List title="Steps" ordered>
 *   <ListItem>First</ListItem>
 *   <ListItem>Second</ListItem>
 * </List>
 *
 * // Task list (checkboxes)
 * <List title="Tasks" task>
 *   <ListItem checked>Done</ListItem>
 *   <ListItem checked={false}>Not done</ListItem>
 * </List>
 * ```
 */
export interface ListProps extends BaseProps {
  /** Optional title/heading for the list */
  title?: string;
  /** Render as ordered (numbered) list */
  ordered?: boolean;
  /** Render as task list with checkboxes */
  task?: boolean;
  children?: any;
}
export function List(props: ListProps): JSX.Element {
  return h("List", props);
}

/**
 * List item component
 *
 * When used inside a task list (`<List task>`), the `checked` prop
 * controls the checkbox state.
 */
export interface ListItemProps extends BaseProps {
  /**
   * Checkbox state for task list items.
   * - `true`: checked (`[x]`)
   * - `false`: unchecked (`[ ]`)
   * - `undefined`: no checkbox (only valid if parent List doesn't have `task` prop)
   */
  checked?: boolean;
  children?: any;
}
export function ListItem(props: ListItemProps): JSX.Element {
  return h("ListItem", props);
}

/**
 * Table content block for displaying tabular data.
 *
 * @example
 * ```tsx
 * // Simple table with headers and rows props
 * <Table headers={['Name', 'Age']} rows={[['John', '30'], ['Jane', '25']]} />
 *
 * // Table with headers prop and Row/Column children
 * <Table headers={['Name', 'Age']}>
 *   <Row>
 *     <Column>John</Column>
 *     <Column align="right">30</Column>
 *   </Row>
 *   <Row>
 *     <Column>Jane</Column>
 *     <Column align="right">25</Column>
 *   </Row>
 * </Table>
 *
 * // Table with header row defined via Row component
 * <Table>
 *   <Row header>
 *     <Column>Name</Column>
 *     <Column align="right">Age</Column>
 *   </Row>
 *   <Row>
 *     <Column>John</Column>
 *     <Column align="right">30</Column>
 *   </Row>
 * </Table>
 * ```
 */
export interface TableProps extends BaseProps {
  children?: any;
  name?: string;
  description?: string;
  headers?: string[];
  rows?: string[][];
}
export function Table(props: TableProps): JSX.Element {
  return h("Table", props);
}

/**
 * Row content block.
 */
export interface RowProps extends BaseProps {
  children?: any;
  header?: boolean;
}
export function Row(props: RowProps): JSX.Element {
  return h("Row", props);
}

/**
 * Column content block.
 */
export interface ColumnProps extends BaseProps {
  children?: any;
  align?: "left" | "center" | "right";
}
export function Column(props: ColumnProps): JSX.Element {
  return h("Column", { align: "left", ...props });
}

// Note: For inline text formatting, use lowercase intrinsic elements:
// <strong>, <b>, <em>, <i>, <code>, <mark>, etc.
// These work without imports via JSX.IntrinsicElements.
