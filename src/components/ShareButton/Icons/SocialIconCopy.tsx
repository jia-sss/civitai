import { Center, useMantineTheme } from '@mantine/core';
import { IconCopy, IconCheck } from '@tabler/icons-react';

export function SocialIconCopy({ copied }: { copied: boolean }) {
  const theme = useMantineTheme();
  const { background } = theme.variantColorResolver({
    color: copied ? 'green' : 'gray',
    variant: 'filled',
    theme,
  });

  return (
    <Center style={{ height: '100%', width: '100%', background, borderRadius: '100%' }}>
      {copied ? <IconCheck /> : <IconCopy />}
    </Center>
  );
}
