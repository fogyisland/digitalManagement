import { useState, type ReactNode } from 'react';
import { Modal, type FormInstance } from 'antd';

export interface FormModalProps<T extends object> {
  open: boolean;
  title: ReactNode;
  /** The form instance the modal drives. */
  form: FormInstance<T>;
  onCancel: () => void;
  /**
   * Called with the validated values. May be async — the modal shows a
   * loading state until it settles. If it throws, the modal stays open
   * so the user can retry.
   */
  onSubmit: (values: T) => Promise<void> | void;
  okText?: string;
  cancelText?: string;
  width?: number;
  children: ReactNode;
  /**
   * Called when the user presses OK but the form does not validate.
   * AntD already renders the per-field errors; this hook is for anything
   * extra (a toast, a log).
   */
  onValidationError?: (error: unknown) => void;
}

/**
 * A modal wired to an AntD form.
 *
 * Four pages had the same shape written out by hand, and three of them got
 * it wrong in the same way: `validateFields()` was called *outside* the
 * `try` block, so a validation failure rejected the promise returned by the
 * submit handler. The caller only did `void onSubmit()`, so the rejection
 * surfaced as an unhandled promise rejection in the console and the user
 * saw nothing at all.
 *
 * This component owns that sequence: validate first, then submit, and never
 * let a validation error escape as a rejection.
 */
export default function FormModal<T extends object>({
  open,
  title,
  form,
  onCancel,
  onSubmit,
  okText = '保存',
  cancelText = '取消',
  width = 480,
  children,
  onValidationError,
}: FormModalProps<T>): JSX.Element {
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async (): Promise<void> => {
    let values: T;
    try {
      values = await form.validateFields();
    } catch (error: unknown) {
      // AntD has already marked the offending fields. Swallow the
      // rejection here so it never escapes as an unhandled rejection.
      onValidationError?.(error);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={() => void handleOk()}
      confirmLoading={submitting}
      okText={okText}
      cancelText={cancelText}
      width={width}
      // A submit in flight must not be interrupted by a stray click.
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={!submitting}
    >
      {children}
    </Modal>
  );
}
