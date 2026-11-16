export function Field({
  name,
  id = name,
  label,
  type = 'text',
  value,
  required = true,
  autoComplete,
}: {
  name: string;
  id?: string;
  label: string;
  type?: string;
  value?: string | number;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        {...(type === 'number'
          ? {
              min:
                name === 'pallets'
                  ? 1
                  : ['price', 'rate'].includes(name)
                    ? 0.01
                    : Number.MIN_VALUE,
              step:
                name === 'pallets' ? 1 : ['price', 'rate'].includes(name) ? 0.01 : 'any',
              max:
                name === 'pallets'
                  ? Number.MAX_SAFE_INTEGER
                  : ['price', 'rate'].includes(name)
                    ? Number.MAX_SAFE_INTEGER / 100
                    : undefined,
            }
          : {})}
        minLength={type === 'password' ? 12 : undefined}
        maxLength={type === 'password' ? 128 : undefined}
        autoComplete={
          autoComplete ?? (type === 'password' ? 'current-password' : undefined)
        }
      />
    </div>
  );
}
