import React from 'react';
import { Box, FilterDrawer, useListResource } from 'adminjs';

const MenuList = () => {
  const { resource, filters, records, sort } = useListResource();

  return (
    <Box>
      <FilterDrawer isVisible resource={resource} filters={filters} />
      {/* デフォルトのテーブルビュー */}
      <Box mt="xl">
        <resource.components.List />
      </Box>
    </Box>
  );
};

export default MenuList;